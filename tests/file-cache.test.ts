import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// getFileLines is re-imported fresh per test via vi.resetModules() so each
// test starts with an empty module-level cache.
let getFileLines: (filePath: string) => string[];

let tmpDir: string;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "knocoph-cache-test-"));
  vi.resetModules();
  ({ getFileLines } = await import("../src/file-cache.js"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Cache miss
// ---------------------------------------------------------------------------

describe("getFileLines — cache miss", () => {
  it("reads file from disk and splits by newline", () => {
    const fp = path.join(tmpDir, "a.ts");
    fs.writeFileSync(fp, "line1\nline2\nline3");

    const lines = getFileLines(fp);

    expect(lines).toEqual(["line1", "line2", "line3"]);
  });

  it("returns a single-element array for a file with no newlines", () => {
    const fp = path.join(tmpDir, "b.ts");
    fs.writeFileSync(fp, "single line");

    const lines = getFileLines(fp);

    expect(lines).toEqual(["single line"]);
  });
});

// ---------------------------------------------------------------------------
// Cache hit
// ---------------------------------------------------------------------------

describe("getFileLines — cache hit", () => {
  it("returns cached content even after file is modified on disk", () => {
    const fp = path.join(tmpDir, "c.ts");
    fs.writeFileSync(fp, "original");

    const first = getFileLines(fp);
    fs.writeFileSync(fp, "modified");
    const second = getFileLines(fp);

    expect(second).toEqual(["original"]);
    expect(second).toEqual(first); // same array reference
  });
});

// ---------------------------------------------------------------------------
// LRU eviction
// ---------------------------------------------------------------------------

describe("getFileLines — LRU eviction", () => {
  it("evicts the oldest entry when more than 50 files are cached", () => {
    // Insert "oldest" as the first cache entry, then mutate it on disk.
    const oldest = path.join(tmpDir, "oldest.ts");
    fs.writeFileSync(oldest, "old content");
    getFileLines(oldest);
    fs.writeFileSync(oldest, "new content");

    // Fill the cache with 50 more unique files; the 51st insert evicts oldest.
    for (let i = 0; i < 50; i++) {
      const fp = path.join(tmpDir, `fill-${i}.ts`);
      fs.writeFileSync(fp, `content ${i}`);
      getFileLines(fp);
    }

    // oldest was evicted — re-reading it fetches the mutated content from disk.
    const afterEviction = getFileLines(oldest);
    expect(afterEviction).toEqual(["new content"]);
  });
});

// ---------------------------------------------------------------------------
// LRU promotion
// ---------------------------------------------------------------------------

describe("getFileLines — LRU promotion", () => {
  it("promotes a re-read entry so it is not the next to be evicted", () => {
    // Read fileA first so it is the oldest entry in the cache.
    const fileA = path.join(tmpDir, "a.ts");
    fs.writeFileSync(fileA, "original A");
    getFileLines(fileA); // cache: {A}  →  size 1

    // Fill 49 more unique files so the cache reaches capacity (50 entries).
    // A is still at the front (oldest position).
    for (let i = 0; i < 49; i++) {
      const fp = path.join(tmpDir, `fill-${i}.ts`);
      fs.writeFileSync(fp, `content ${i}`);
      getFileLines(fp);
    }
    // cache: {A, fill-0, fill-1, ..., fill-48}  →  size 50

    // Mutate fileA on disk so we can detect a future cache miss.
    fs.writeFileSync(fileA, "mutated A");

    // Re-read fileA — this promotes A from front (oldest) to back (newest).
    // cache: {fill-0, fill-1, ..., fill-48, A}
    getFileLines(fileA);

    // Insert one more entry — this evicts fill-0 (the new oldest), not A.
    const extra = path.join(tmpDir, "extra.ts");
    fs.writeFileSync(extra, "extra");
    getFileLines(extra); // evicts fill-0; A survives

    // A is still cached — should return "original A", not the mutated disk content.
    const result = getFileLines(fileA);
    expect(result).toEqual(["original A"]);
  });
});
