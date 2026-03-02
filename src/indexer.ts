import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import type Database from "better-sqlite3";

import {
  clearGraph,
  deleteFile,
  insertEdge,
  insertFile,
  insertNode,
  writeTransaction,
} from "./graph.js";
import { parseFile } from "./parser.js";
import type { IndexStats } from "./types.js";

// Bump this version whenever parser logic changes in a way that affects
// extracted nodes or edges. When the stored version differs from this
// constant, indexProject clears the graph and forces a full re-parse so
// stale data from the old parser does not persist.
export const PARSER_VERSION = 2;

// ---------------------------------------------------------------------------
// indexFile
// ---------------------------------------------------------------------------

// Index a single file into the graph. If the file's hash matches what is
// already stored, the file is skipped (no DB writes). Otherwise the old data
// is deleted and the new parse results are written in a single transaction.
//
// Returns a status discriminated union so callers can aggregate stats without
// needing to catch errors themselves.
export function indexFile(
  db: Database.Database,
  filePath: string
): { status: "updated" | "skipped" | "error"; error?: string } {
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch (e) {
    return {
      status: "error",
      error: e instanceof Error ? e.message : String(e),
    };
  }

  const hash = createHash("sha256").update(content).digest("hex");

  const existing = db
    .prepare("SELECT content_hash FROM files WHERE path = ?")
    .get(filePath) as { content_hash: string } | undefined;

  if (existing?.content_hash === hash) {
    return { status: "skipped" };
  }

  let parsed: ReturnType<typeof parseFile>;
  try {
    parsed = parseFile(filePath, content);
  } catch (e) {
    return {
      status: "error",
      error: e instanceof Error ? e.message : String(e),
    };
  }

  try {
    writeTransaction(db, () => {
      deleteFile(db, filePath);
      insertFile(db, filePath, hash);
      for (const n of parsed.nodes) insertNode(db, n);
      for (const e of parsed.edges) insertEdge(db, e);
    });
  } catch (e) {
    return {
      status: "error",
      error: e instanceof Error ? e.message : String(e),
    };
  }

  return { status: "updated" };
}

// ---------------------------------------------------------------------------
// indexProject
// ---------------------------------------------------------------------------

// Full or incremental scan of a project directory. Files matching any of the
// glob patterns (relative to rootDir) and not excluded by the ignore list are
// considered. Files whose content hash has not changed since the last index
// are skipped without DB writes.
//
// Logs progress to stderr every 100 files so long-running scans are visible.
// stdout is reserved for MCP JSON-RPC protocol — never write to stdout here.
export function indexProject(
  db: Database.Database,
  rootDir: string,
  globs: string[],
  ignore: string[]
): IndexStats {
  const start = Date.now();
  const stats: IndexStats = {
    files_scanned: 0,
    files_updated: 0,
    files_skipped: 0,
    files_errored: 0,
    duration_ms: 0,
  };

  // Check parser version — if it differs, clear the entire graph so every
  // file is re-parsed with the current parser logic.
  const storedVersion = db
    .prepare("SELECT value FROM meta WHERE key = 'parser_version'")
    .get() as { value: string } | undefined;

  if (storedVersion?.value !== String(PARSER_VERSION)) {
    console.error(
      `[knocoph] Parser version changed (${storedVersion?.value ?? "none"} → ${PARSER_VERSION}), forcing full re-index`
    );
    clearGraph(db);
  }

  // Collect all matching paths across all glob patterns. Deduplicate so a
  // file matched by two patterns is indexed only once.
  const seen = new Set<string>();

  for (const pattern of globs) {
    const matches = fs.globSync(pattern, {
      cwd: rootDir,
      exclude: ignore.length > 0 ? ignore : undefined,
    });
    for (const rel of matches) {
      const abs = path.resolve(rootDir, rel);
      seen.add(abs);
    }
  }

  for (const filePath of seen) {
    stats.files_scanned++;

    const result = indexFile(db, filePath);
    if (result.status === "updated") stats.files_updated++;
    else if (result.status === "skipped") stats.files_skipped++;
    else stats.files_errored++;

    if (stats.files_scanned % 100 === 0) {
      console.error("[knocoph] Indexed", stats.files_scanned, "...");
    }
  }

  stats.duration_ms = Date.now() - start;

  // Persist current parser version so the next run can detect changes.
  db.prepare("INSERT OR REPLACE INTO meta VALUES ('parser_version', ?)").run(
    String(PARSER_VERSION)
  );

  return stats;
}
