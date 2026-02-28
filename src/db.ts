import Database from "better-sqlite3";

export const SCHEMA_SQL = `
-- Both pragmas must run on every new database connection.
-- SQLite disables foreign key enforcement by default.
-- Without PRAGMA foreign_keys = ON, ON DELETE CASCADE is silently ignored.
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

-- [v1] One row per indexed source file
CREATE TABLE IF NOT EXISTS files (
  path         TEXT PRIMARY KEY,   -- absolute path used consistently throughout
  content_hash TEXT NOT NULL,      -- SHA-256 hex digest of file contents
  indexed_at   INTEGER NOT NULL    -- Unix millisecond timestamp
) STRICT;

-- [v1] One row per extracted symbol
CREATE TABLE IF NOT EXISTS nodes (
  id         TEXT PRIMARY KEY,      -- sha256(file_path + ":" + name + ":" + kind)
  name       TEXT NOT NULL,         -- symbol name exactly as written in source
  kind       TEXT NOT NULL,         -- function | class | interface | type_alias | enum |
                                    -- namespace | method | constructor | arrow_function | variable
  file_path  TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,
  start_line INTEGER NOT NULL,      -- 1-indexed
  end_line   INTEGER NOT NULL,      -- 1-indexed
  exported   INTEGER NOT NULL DEFAULT 0   -- 1 if exported from module, 0 if internal
) STRICT;

-- [v1] One row per directed relationship between symbols
CREATE TABLE IF NOT EXISTS edges (
  source_id         TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  target_id         TEXT NOT NULL,   -- no FK -- allowed to dangle for external/unresolved targets
  relationship_type TEXT NOT NULL,   -- IMPORTS | EXPORTS | CALLS | EXTENDS | IMPLEMENTS | CONTAINS
  PRIMARY KEY (source_id, target_id, relationship_type)
) STRICT;

-- [v1] Key-value store for server configuration persistence.
-- Allows the file watcher to auto-start on server boot across Claude Code restarts.
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;
-- Keys used:
--   'root_dir'  TEXT  -- absolute path of the indexed project root
--   'globs'     TEXT  -- JSON array of glob patterns
--   'ignore'    TEXT  -- JSON array of ignore patterns

-- Indexes covering every query pattern used in queries.ts
CREATE INDEX IF NOT EXISTS idx_nodes_name      ON nodes(name);
CREATE INDEX IF NOT EXISTS idx_nodes_file_path ON nodes(file_path);
CREATE INDEX IF NOT EXISTS idx_edges_source    ON edges(source_id);
CREATE INDEX IF NOT EXISTS idx_edges_target    ON edges(target_id);
`;

export function openDatabase(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  return db;
}
