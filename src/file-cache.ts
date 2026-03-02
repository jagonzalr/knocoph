import fs from "node:fs";

// Module-level LRU cache: file path -> lines array.
// Maps preserve insertion order — oldest entry is always at the front.
// Max 50 entries; evict oldest on overflow.
const fileCache = new Map<string, string[]>();
const MAX_CACHE_SIZE = 50;

export function getFileLines(filePath: string): string[] {
  if (fileCache.has(filePath)) {
    const lines = fileCache.get(filePath)!;
    fileCache.delete(filePath); // remove from current position
    fileCache.set(filePath, lines); // re-insert at end (LRU promotion)
    return lines;
  }
  if (fileCache.size >= MAX_CACHE_SIZE) {
    fileCache.delete(fileCache.keys().next().value!); // evict oldest
  }
  const lines = fs.readFileSync(filePath, "utf-8").split("\n");
  fileCache.set(filePath, lines);
  return lines;
}
