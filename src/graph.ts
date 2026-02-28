import type Database from "better-sqlite3";

import type { ParsedEdge, ParsedNode } from "./types.js";

export function insertFile(
  db: Database.Database,
  path: string,
  hash: string
): void {
  db.prepare("INSERT OR REPLACE INTO files VALUES (?, ?, ?)").run(
    path,
    hash,
    Date.now()
  );
}

export function insertNode(db: Database.Database, node: ParsedNode): void {
  db.prepare("INSERT OR IGNORE INTO nodes VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    node.id,
    node.name,
    node.kind,
    node.file_path,
    node.start_line,
    node.end_line,
    node.exported
  );
}

export function insertEdge(db: Database.Database, edge: ParsedEdge): void {
  db.prepare("INSERT OR IGNORE INTO edges VALUES (?, ?, ?)").run(
    edge.source_id,
    edge.target_id,
    edge.relationship_type
  );
}

export function deleteFile(db: Database.Database, path: string): void {
  db.prepare("DELETE FROM files WHERE path = ?").run(path);
}

// Only place in the codebase where transactions are constructed.
export function writeTransaction(db: Database.Database, fn: () => void): void {
  db.transaction(fn)();
}
