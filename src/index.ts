#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { openDatabase } from "./db.js";
import { indexProject } from "./indexer.js";
import { createServer } from "./server.js";
import type { PathAliases } from "./types.js";
import { startWatcher } from "./watcher.js";

// Reads tsconfig.json at the given path and returns PathAliases if
// compilerOptions.paths is defined. Returns undefined on parse failure or
// when no paths are configured.
function loadPathAliasesFromTsconfig(
  tsconfigPath: string
): PathAliases | undefined {
  try {
    const raw = fs.readFileSync(tsconfigPath, "utf-8");
    const stripped = raw.replace(/\/\/[^\n]*/g, "");
    const tsconfig = JSON.parse(stripped) as {
      compilerOptions?: {
        baseUrl?: string;
        paths?: Record<string, string[]>;
      };
    };
    const tsPaths = tsconfig.compilerOptions?.paths;
    if (tsPaths && Object.keys(tsPaths).length > 0) {
      const baseUrl = tsconfig.compilerOptions?.baseUrl ?? ".";
      return {
        baseDir: path.resolve(path.dirname(tsconfigPath), baseUrl),
        paths: tsPaths,
      };
    }
  } catch (e) {
    console.error(
      `[knocoph] Failed to parse tsconfig at ${tsconfigPath}: ${e instanceof Error ? e.message : String(e)}`
    );
  }
  return undefined;
}

// Resolves the tsconfig to use: explicit stored path takes priority, then
// auto-detect tsconfig.json at the project root.
function resolvePathAliases(
  rootDir: string,
  storedTsconfigPath?: string
): PathAliases | undefined {
  const tsconfigPath =
    storedTsconfigPath && storedTsconfigPath.length > 0
      ? storedTsconfigPath
      : fs.existsSync(path.join(rootDir, "tsconfig.json"))
        ? path.join(rootDir, "tsconfig.json")
        : undefined;
  if (!tsconfigPath) return undefined;
  console.error(`[knocoph] Loading path aliases from ${tsconfigPath}`);
  return loadPathAliasesFromTsconfig(tsconfigPath);
}

// knocoph_DB: path to the SQLite database file.
// Relative paths resolve from the working directory of the spawned process.
const dbPath = path.resolve(process.env["knocoph_DB"] ?? "./.knocoph/graph.db");

// Ensure the parent directory exists before opening the database.
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

console.error("[knocoph] Opening database at", dbPath);
const db = openDatabase(dbPath);

// Auto-start watcher if meta config is present from a previous index_project run.
// Claude Code or other CLIs re-spawns the server process on every restart; reading the meta table
// keeps the watcher alive across restarts without requiring the user to re-index.
const rootDirRow = db
  .prepare("SELECT value FROM meta WHERE key = 'root_dir'")
  .get() as { value: string } | undefined;
const globsRow = db
  .prepare("SELECT value FROM meta WHERE key = 'globs'")
  .get() as { value: string } | undefined;
const ignoreRow = db
  .prepare("SELECT value FROM meta WHERE key = 'ignore'")
  .get() as { value: string } | undefined;

const tsconfigPathRow = db
  .prepare("SELECT value FROM meta WHERE key = 'tsconfig_path'")
  .get() as { value: string } | undefined;

if (
  rootDirRow !== undefined &&
  globsRow !== undefined &&
  ignoreRow !== undefined
) {
  const rootDir = rootDirRow.value;
  const globs = JSON.parse(globsRow.value) as string[];
  const ignore = JSON.parse(ignoreRow.value) as string[];
  const pathAliases = resolvePathAliases(rootDir, tsconfigPathRow?.value);
  // Re-index on restart so the graph reflects any files added, modified, or
  // deleted while the server was not running.  Unchanged files are skipped
  // by content-hash comparison, so this is cheap for stable codebases.
  console.error("[knocoph] Re-indexing", rootDir);
  const stats = indexProject(db, rootDir, globs, ignore, pathAliases);
  console.error(
    `[knocoph] Re-index complete: ${stats.files_updated} updated, ${stats.files_skipped} unchanged in ${stats.duration_ms}ms`
  );

  startWatcher(db, rootDir, globs, ignore, pathAliases);
} else {
  // Fresh installation — no previous index_project run found in meta.
  // Auto-index using knocoph_ROOT (or cwd as fallback) so tools like
  // find_symbol work immediately without requiring a manual first call.
  const defaultGlobs = [
    "**/*.ts",
    "**/*.tsx",
    "**/*.js",
    "**/*.jsx",
    "**/*.mjs",
    "**/*.cjs",
  ];
  const defaultIgnore = [
    "**/node_modules/**",
    "**/dist/**",
    "**/build/**",
    "**/.git/**",
    "**/.knocoph/**",
  ];
  const rootDir = path.resolve(process.env["knocoph_ROOT"] ?? ".");
  const pathAliases = resolvePathAliases(rootDir);
  console.error("[knocoph] Fresh installation — auto-indexing", rootDir);
  const stats = indexProject(
    db,
    rootDir,
    defaultGlobs,
    defaultIgnore,
    pathAliases
  );
  console.error(
    `[knocoph] Initial index complete: ${stats.files_updated} file(s) indexed in ${stats.duration_ms}ms`
  );
  db.prepare("INSERT OR REPLACE INTO meta VALUES ('root_dir', ?)").run(rootDir);
  db.prepare("INSERT OR REPLACE INTO meta VALUES ('globs', ?)").run(
    JSON.stringify(defaultGlobs)
  );
  db.prepare("INSERT OR REPLACE INTO meta VALUES ('ignore', ?)").run(
    JSON.stringify(defaultIgnore)
  );
  startWatcher(db, rootDir, defaultGlobs, defaultIgnore, pathAliases);
}

const server = createServer(db);
const transport = new StdioServerTransport();
await server.connect(transport);
