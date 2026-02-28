import path from "node:path";

import type Database from "better-sqlite3";
import chokidar, { type FSWatcher } from "chokidar";

import { deleteFile } from "./graph.js";
import { indexFile } from "./indexer.js";

export let activeWatcher: FSWatcher | null = null;

export function startWatcher(
  db: Database.Database,
  rootDir: string,
  globs: string[],
  ignore: string[]
): void {
  if (activeWatcher !== null) {
    activeWatcher.close();
    activeWatcher = null;
  }

  const pending = new Map<string, ReturnType<typeof setTimeout>>();

  const handleChange = (relativePath: string): void => {
    const absolutePath = path.resolve(rootDir, relativePath);
    const existing = pending.get(absolutePath);
    if (existing !== undefined) clearTimeout(existing);
    pending.set(
      absolutePath,
      setTimeout(() => {
        pending.delete(absolutePath);
        indexFile(db, absolutePath);
      }, 500)
    );
  };

  const watcher = chokidar.watch(globs, {
    cwd: rootDir,
    ignored: ignore,
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
  });

  watcher.on("add", handleChange);
  watcher.on("change", handleChange);
  watcher.on("unlink", (relativePath: string) => {
    deleteFile(db, path.resolve(rootDir, relativePath));
  });
  watcher.on("error", (err: unknown) => {
    console.error("[Knocoph] Watcher error:", err);
  });

  activeWatcher = watcher;
  console.error("[Knocoph] Watcher started for", rootDir);
}
