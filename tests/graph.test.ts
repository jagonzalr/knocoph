import { afterAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SCHEMA_SQL, openDatabase } from "../src/db.js";
import {
  clearGraph,
  deleteFile,
  insertEdge,
  insertFile,
  insertNode,
  writeTransaction,
} from "../src/graph.js";
import type { ParsedEdge, ParsedNode } from "../src/types.js";

// Helper: fresh in-memory DB with schema applied.
// Does NOT call openDatabase() — keeps each test independent of db.ts behavior.
function makeDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  return db;
}

const TEST_FILE = "/tmp/knocoph-test-file.ts";
const TEST_HASH = "abc123def456";

const TEST_NODE: ParsedNode = {
  id: "node-abc",
  name: "foo",
  kind: "function",
  file_path: TEST_FILE,
  start_line: 1,
  end_line: 5,
  exported: 1,
};

const TEST_EDGE: ParsedEdge = {
  source_id: "node-abc",
  target_id: "node-xyz",
  relationship_type: "CALLS",
};

describe("cascade delete", () => {
  it("deleting a file removes its nodes and edges", () => {
    const db = makeDb();
    insertFile(db, TEST_FILE, TEST_HASH);
    insertNode(db, TEST_NODE);
    insertEdge(db, TEST_EDGE);

    // Confirm rows exist before delete
    expect(
      db.prepare("SELECT id FROM nodes WHERE id = ?").get("node-abc")
    ).toBeTruthy();
    expect(
      db
        .prepare("SELECT source_id FROM edges WHERE source_id = ?")
        .get("node-abc")
    ).toBeTruthy();

    deleteFile(db, TEST_FILE);

    // Both node and edge must be gone — CASCADE is the incremental update mechanism
    expect(
      db.prepare("SELECT id FROM nodes WHERE id = ?").get("node-abc")
    ).toBeUndefined();
    expect(
      db
        .prepare("SELECT source_id FROM edges WHERE source_id = ?")
        .get("node-abc")
    ).toBeUndefined();
  });
});

describe("FK enforcement", () => {
  it("throws when inserting a node whose file_path is not in files", () => {
    const db = makeDb();
    expect(() => insertNode(db, TEST_NODE)).toThrow(
      /FOREIGN KEY constraint failed/
    );
  });
});

describe("silent duplicate node", () => {
  it("inserting the same node twice produces exactly one row", () => {
    const db = makeDb();
    insertFile(db, TEST_FILE, TEST_HASH);
    insertNode(db, TEST_NODE);
    insertNode(db, TEST_NODE);
    const rows = db
      .prepare("SELECT id FROM nodes WHERE id = ?")
      .all("node-abc");
    expect(rows).toHaveLength(1);
  });
});

describe("silent duplicate edge", () => {
  it("inserting the same edge twice produces exactly one row", () => {
    const db = makeDb();
    insertFile(db, TEST_FILE, TEST_HASH);
    insertNode(db, TEST_NODE);
    insertEdge(db, TEST_EDGE);
    insertEdge(db, TEST_EDGE);
    const rows = db
      .prepare("SELECT source_id FROM edges WHERE source_id = ?")
      .all("node-abc");
    expect(rows).toHaveLength(1);
  });
});

describe("openDatabase", () => {
  let tempDir: string;

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("WAL mode is enabled", () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "knocoph-test-"));
    const dbPath = path.join(tempDir, "test.db");
    const db = openDatabase(dbPath);
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    db.close();
  });

  it("foreign keys are enabled", () => {
    const dbPath = path.join(tempDir, "test.db");
    const db = openDatabase(dbPath);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    db.close();
  });
});

describe("writeTransaction rollback", () => {
  it("rolls back all writes when an error is thrown inside the transaction", () => {
    const db = makeDb();
    insertFile(db, TEST_FILE, TEST_HASH);

    expect(() => {
      writeTransaction(db, () => {
        insertNode(db, TEST_NODE);
        throw new Error("intentional rollback");
      });
    }).toThrow("intentional rollback");

    const rows = db.prepare("SELECT id FROM nodes").all();
    expect(rows).toHaveLength(0);
  });
});

describe("clearGraph", () => {
  it("removes all files, nodes, and edges", () => {
    const db = makeDb();
    insertFile(db, TEST_FILE, TEST_HASH);
    insertNode(db, TEST_NODE);
    insertEdge(db, TEST_EDGE);

    // Verify data exists
    expect(db.prepare("SELECT COUNT(*) as n FROM files").get()).toEqual({
      n: 1,
    });
    expect(db.prepare("SELECT COUNT(*) as n FROM nodes").get()).toEqual({
      n: 1,
    });
    expect(db.prepare("SELECT COUNT(*) as n FROM edges").get()).toEqual({
      n: 1,
    });

    clearGraph(db);

    expect(db.prepare("SELECT COUNT(*) as n FROM files").get()).toEqual({
      n: 0,
    });
    expect(db.prepare("SELECT COUNT(*) as n FROM nodes").get()).toEqual({
      n: 0,
    });
    expect(db.prepare("SELECT COUNT(*) as n FROM edges").get()).toEqual({
      n: 0,
    });
  });
});
