import path from "node:path";
import fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";

import { SCHEMA_SQL } from "../src/db.js";
import { indexProject } from "../src/indexer.js";
import { getImportersOf } from "../src/queries.js";

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  return db;
}

// ---------------------------------------------------------------------------
// getImportersOf
// ---------------------------------------------------------------------------

describe("getImportersOf", () => {
  let db: Database.Database;
  let testDir: string;
  let baseFile: string;
  let importer1: string;
  let importer2: string;

  beforeAll(async () => {
    testDir = path.join(process.cwd(), "test-temp-ripple");
    fs.mkdirSync(testDir, { recursive: true });

    baseFile = path.join(testDir, "base.ts");
    fs.writeFileSync(
      baseFile,
      [
        "export function baseFunction() { return 'initial'; }",
        "export const constant = 42;",
      ].join("\n")
    );

    importer1 = path.join(testDir, "importer1.ts");
    fs.writeFileSync(
      importer1,
      [
        "import { baseFunction, constant } from './base.js';",
        "export function useBase() { return baseFunction() + constant; }",
      ].join("\n")
    );

    importer2 = path.join(testDir, "importer2.ts");
    fs.writeFileSync(
      importer2,
      [
        "import { baseFunction } from './base.js';",
        "export class Consumer { getValue() { return baseFunction(); } }",
      ].join("\n")
    );

    db = makeDb();
    await indexProject(db, testDir, ["**/*.ts"], []);
  });

  afterAll(() => {
    db.close();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it("returns all files that directly import the given file", () => {
    const importers = getImportersOf(db, baseFile);
    expect(importers).toHaveLength(2);
    expect(importers).toContain(importer1);
    expect(importers).toContain(importer2);
  });

  it("returns empty array when no file imports the given file", () => {
    // importer1.ts is not imported by anyone
    const importers = getImportersOf(db, importer1);
    expect(importers).toHaveLength(0);
  });

  it("returns empty array for a non-existent file path", () => {
    const importers = getImportersOf(db, "/nonexistent/path/ghost.ts");
    expect(importers).toHaveLength(0);
  });

  it("returns results sorted by file_path", () => {
    const importers = getImportersOf(db, baseFile);
    const sorted = [...importers].sort();
    expect(importers).toEqual(sorted);
  });
});

// ---------------------------------------------------------------------------
// getImportersOf — high-importer cap scenario
// ---------------------------------------------------------------------------

describe("getImportersOf — more than 20 importers", () => {
  let db: Database.Database;
  let capTestDir: string;
  let capBaseFile: string;

  beforeAll(async () => {
    capTestDir = path.join(process.cwd(), "test-temp-ripple-cap");
    fs.mkdirSync(capTestDir, { recursive: true });

    capBaseFile = path.join(capTestDir, "base.ts");
    fs.writeFileSync(capBaseFile, "export function lib() { return 1; }");

    for (let i = 1; i <= 25; i++) {
      const filePath = path.join(capTestDir, `consumer${i}.ts`);
      fs.writeFileSync(
        filePath,
        `import { lib } from './base.js';\nexport const v${i} = lib();`
      );
    }

    db = makeDb();
    await indexProject(db, capTestDir, ["**/*.ts"], []);
  });

  afterAll(() => {
    db.close();
    fs.rmSync(capTestDir, { recursive: true, force: true });
  });

  it("returns all 25 importers (watcher will skip ripple beyond 20)", () => {
    const importers = getImportersOf(db, capBaseFile);
    expect(importers).toHaveLength(25);
  });
});
