import fs from "node:fs";
import path from "node:path";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { openDatabase } from "./db.js";
import { createServer } from "./server.js";
import { startWatcher } from "./watcher.js";

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

if (
  rootDirRow !== undefined &&
  globsRow !== undefined &&
  ignoreRow !== undefined
) {
  const rootDir = rootDirRow.value;
  const globs = JSON.parse(globsRow.value) as string[];
  const ignore = JSON.parse(ignoreRow.value) as string[];
  console.error("[knocoph] Auto-starting watcher for", rootDir);
  startWatcher(db, rootDir, globs, ignore);
}

const server = createServer(db);
const transport = new StdioServerTransport();
await server.connect(transport);
