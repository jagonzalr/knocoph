import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase } from "../src/db.js";
import { indexFile, indexProject, PARSER_VERSION } from "../src/indexer.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function countNodes(db: Database.Database): number {
  const row = db.prepare("SELECT COUNT(*) as n FROM nodes").get() as {
    n: number;
  };
  return row.n;
}

function findNodeByName(
  db: Database.Database,
  name: string
): { name: string } | undefined {
  return db.prepare("SELECT name FROM nodes WHERE name = ?").get(name) as
    | { name: string }
    | undefined;
}

function getFileHash(
  db: Database.Database,
  filePath: string
): string | undefined {
  const row = db
    .prepare("SELECT content_hash FROM files WHERE path = ?")
    .get(filePath) as { content_hash: string } | undefined;
  return row?.content_hash;
}

// ---------------------------------------------------------------------------
// Test state — a fresh temp dir and in-memory DB per test
// ---------------------------------------------------------------------------

let tmpDir: string;
let db: Database.Database;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "knocoph-test-"));
  db = openDatabase(":memory:");
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// indexFile tests
// ---------------------------------------------------------------------------

describe("indexFile — first index", () => {
  it("returns updated and inserts the node", () => {
    const file = path.join(tmpDir, "a.ts");
    fs.writeFileSync(file, "export function hello() {}");

    const result = indexFile(db, file);

    expect(result.status).toBe("updated");
    expect(findNodeByName(db, "hello")).toBeDefined();
  });
});

describe("indexFile — skip on no change", () => {
  it("returns skipped and leaves node count unchanged", () => {
    const file = path.join(tmpDir, "a.ts");
    fs.writeFileSync(file, "export function hello() {}");

    indexFile(db, file);
    const countBefore = countNodes(db);

    const result = indexFile(db, file);

    expect(result.status).toBe("skipped");
    expect(countNodes(db)).toBe(countBefore);
  });
});

describe("indexFile — update on content change", () => {
  it("returns updated and stores a new hash", () => {
    const file = path.join(tmpDir, "a.ts");
    fs.writeFileSync(file, "export function hello() {}");
    indexFile(db, file);

    const hashBefore = getFileHash(db, file);

    fs.appendFileSync(file, "\n// updated");
    const result = indexFile(db, file);

    expect(result.status).toBe("updated");
    expect(getFileHash(db, file)).not.toBe(hashBefore);
  });
});

describe("indexFile — symbol rename", () => {
  it("old name absent, new name present after re-index", () => {
    const file = path.join(tmpDir, "a.ts");
    fs.writeFileSync(file, "export function hello() {}");
    indexFile(db, file);

    expect(findNodeByName(db, "hello")).toBeDefined();

    fs.writeFileSync(file, "export function goodbye() {}");
    const result = indexFile(db, file);

    expect(result.status).toBe("updated");
    expect(findNodeByName(db, "goodbye")).toBeDefined();
    expect(findNodeByName(db, "hello")).toBeUndefined();
  });
});

describe("indexFile — error on invalid TypeScript", () => {
  it("returns error and leaves nodes table unchanged", () => {
    const file = path.join(tmpDir, "bad.ts");
    fs.writeFileSync(file, "export { {{{broken");

    const countBefore = countNodes(db);
    const result = indexFile(db, file);

    expect(result.status).toBe("error");
    expect(result.error).toBeDefined();
    expect(countNodes(db)).toBe(countBefore);
  });
});

describe("indexFile — error on file not found", () => {
  it("returns error for a nonexistent path", () => {
    const result = indexFile(db, path.join(tmpDir, "does-not-exist.ts"));

    expect(result.status).toBe("error");
    expect(result.error).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// indexProject tests
// ---------------------------------------------------------------------------

describe("indexProject — full project scan", () => {
  it("indexes all 3 files and reports files_updated === 3", () => {
    fs.writeFileSync(path.join(tmpDir, "a.ts"), "export function alpha() {}");
    fs.writeFileSync(path.join(tmpDir, "b.ts"), "export function beta() {}");
    fs.writeFileSync(path.join(tmpDir, "c.ts"), "export function gamma() {}");

    const stats = indexProject(db, tmpDir, ["**/*.ts"], []);

    expect(stats.files_scanned).toBe(3);
    expect(stats.files_updated).toBe(3);
    expect(stats.files_skipped).toBe(0);
    expect(stats.files_errored).toBe(0);
  });
});

describe("indexProject — incremental scan", () => {
  it("skips all 3 files when nothing has changed", () => {
    fs.writeFileSync(path.join(tmpDir, "a.ts"), "export function alpha() {}");
    fs.writeFileSync(path.join(tmpDir, "b.ts"), "export function beta() {}");
    fs.writeFileSync(path.join(tmpDir, "c.ts"), "export function gamma() {}");

    indexProject(db, tmpDir, ["**/*.ts"], []);
    const stats = indexProject(db, tmpDir, ["**/*.ts"], []);

    expect(stats.files_scanned).toBe(3);
    expect(stats.files_skipped).toBe(3);
    expect(stats.files_updated).toBe(0);
    expect(stats.files_errored).toBe(0);
  });
});

describe("indexProject — ignore patterns", () => {
  it("excludes files matched by ignore list", () => {
    const sub = path.join(tmpDir, "skip");
    fs.mkdirSync(sub);
    fs.writeFileSync(path.join(tmpDir, "keep.ts"), "export function keep() {}");
    fs.writeFileSync(path.join(sub, "skip.ts"), "export function skip() {}");

    const stats = indexProject(db, tmpDir, ["**/*.ts"], ["skip/**"]);

    expect(stats.files_scanned).toBe(1);
    expect(stats.files_updated).toBe(1);
    expect(findNodeByName(db, "keep")).toBeDefined();
    expect(findNodeByName(db, "skip")).toBeUndefined();
  });
});

describe("indexProject — mixed skipped, updated, and errored results", () => {
  it("counts all three status types in a single scan", () => {
    // Part 1: initial index with 3 valid files
    const fileA = path.join(tmpDir, "a.ts");
    const fileB = path.join(tmpDir, "b.ts");
    const fileC = path.join(tmpDir, "c.ts");

    fs.writeFileSync(fileA, "export function Alpha() {}");
    fs.writeFileSync(fileB, "export function Beta() {}");
    fs.writeFileSync(fileC, "export function Gamma() {}");

    indexProject(db, tmpDir, ["**/*.ts"], []);
    const nodeCountAfterFirst = countNodes(db);

    // Part 2: second scan with mixed results
    // - fileA unchanged → should be skipped
    // - fileB rewritten with invalid syntax → should error
    // - fileC unchanged → should be skipped
    // - fileD written new and valid → should be updated
    fs.writeFileSync(fileB, "export { {{{broken");
    const fileD = path.join(tmpDir, "d.ts");
    fs.writeFileSync(fileD, "export function Delta() {}");

    const stats = indexProject(db, tmpDir, ["**/*.ts"], []);

    expect(stats.files_scanned).toBe(4);
    expect(stats.files_updated).toBe(1); // fileD
    expect(stats.files_skipped).toBe(2); // fileA, fileC
    expect(stats.files_errored).toBe(1); // fileB
    // Node count should only increase for Delta (fileB parse fails so no nodes written)
    expect(countNodes(db)).toBeGreaterThan(nodeCountAfterFirst);
    expect(findNodeByName(db, "Delta")).toBeDefined();
  });
});

describe("indexProject — console.error progress logging", () => {
  it("logs progress when files_scanned reaches 100", () => {
    // Write 102 files to trigger the 100-file progress log at least once
    let stderrOutput = "";
    const originalStderr = console.error;
    console.error = (...args: unknown[]) => {
      stderrOutput += args.join(" ") + "\n";
    };

    try {
      // Create 102 TypeScript files
      for (let i = 0; i < 102; i++) {
        fs.writeFileSync(
          path.join(tmpDir, `file${i}.ts`),
          `export function f${i}() {}`
        );
      }

      indexProject(db, tmpDir, ["**/*.ts"], []);

      // The progress message should appear at least once
      expect(stderrOutput).toMatch(/\[Knocoph\] Indexed 100/);
    } finally {
      console.error = originalStderr;
    }
  });
});

describe("indexProject — duration is recorded", () => {
  it("duration_ms is a non-negative integer", () => {
    const stats = indexProject(db, tmpDir, ["**/*.ts"], []);

    expect(stats.duration_ms).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// Parser version invalidation
// ---------------------------------------------------------------------------

describe("indexProject — parser version invalidation", () => {
  it("stores PARSER_VERSION in meta after indexing", () => {
    fs.writeFileSync(path.join(tmpDir, "a.ts"), "export function a() {}");
    indexProject(db, tmpDir, ["**/*.ts"], []);

    const row = db
      .prepare("SELECT value FROM meta WHERE key = 'parser_version'")
      .get() as { value: string } | undefined;
    expect(row?.value).toBe(String(PARSER_VERSION));
  });

  it("forces full re-index when stored parser version differs", () => {
    fs.writeFileSync(path.join(tmpDir, "a.ts"), "export function a() {}");

    // First index — sets parser version.
    const first = indexProject(db, tmpDir, ["**/*.ts"], []);
    expect(first.files_updated).toBe(1);

    // Second index — file unchanged, should skip.
    const second = indexProject(db, tmpDir, ["**/*.ts"], []);
    expect(second.files_skipped).toBe(1);
    expect(second.files_updated).toBe(0);

    // Simulate a parser version change by writing a stale version to meta.
    db.prepare("INSERT OR REPLACE INTO meta VALUES ('parser_version', ?)").run(
      "0"
    );

    // Third index — parser version mismatch forces re-parse.
    const third = indexProject(db, tmpDir, ["**/*.ts"], []);
    expect(third.files_updated).toBe(1);
    expect(third.files_skipped).toBe(0);
  });

  it("forces re-index when no parser version is stored (legacy DB)", () => {
    fs.writeFileSync(path.join(tmpDir, "a.ts"), "export function a() {}");
    indexProject(db, tmpDir, ["**/*.ts"], []);

    // Remove the parser_version row to simulate a legacy database.
    db.prepare("DELETE FROM meta WHERE key = 'parser_version'").run();

    // Next index should detect the missing version and re-parse all files.
    const stats = indexProject(db, tmpDir, ["**/*.ts"], []);
    expect(stats.files_updated).toBe(1);
    expect(stats.files_skipped).toBe(0);
  });
});
