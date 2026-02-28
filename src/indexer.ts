import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import type Database from "better-sqlite3";

import {
  deleteFile,
  insertEdge,
  insertFile,
  insertNode,
  writeTransaction,
} from "./graph.js";
import { parseFile } from "./parser.js";
import type { IndexStats } from "./types.js";

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
      console.error("[Knocoph] Indexed", stats.files_scanned, "...");
    }
  }

  stats.duration_ms = Date.now() - start;
  return stats;
}
