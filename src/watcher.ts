import path from "node:path";
import type { Stats } from "node:fs";

import type Database from "better-sqlite3";
import chokidar, { type FSWatcher } from "chokidar";

import { deleteFile } from "./graph.js";
import { indexFile } from "./indexer.js";
import { getImportersOf } from "./queries.js";
import type { PathAliases } from "./types.js";

export let activeWatcher: FSWatcher | null = null;

export function startWatcher(
  db: Database.Database,
  rootDir: string,
  globs: string[],
  ignore: string[],
  pathAliases?: PathAliases
): void {
  if (activeWatcher !== null) {
    activeWatcher.close();
    activeWatcher = null;
  }

  const pending = new Map<string, ReturnType<typeof setTimeout>>();

  // Build a set of allowed extensions from the glob patterns.
  // e.g. ["**/*.ts", "**/*.tsx"] → Set([".ts", ".tsx"])
  const allowedExtensions = new Set<string>();
  for (const g of globs) {
    const match = g.match(/\*(\.[a-zA-Z]+)$/);
    if (match) allowedExtensions.add(match[1]!);
  }

  // Build a set of directory names to ignore from the ignore patterns.
  // e.g. ["**/node_modules/**"] → Set(["node_modules"])
  const ignoredDirs = new Set<string>();
  for (const pattern of ignore) {
    const match = pattern.match(/\*\*\/([^*/]+)\/\*\*/);
    if (match) ignoredDirs.add(match[1]!);
  }

  const handleChange = (absolutePath: string): void => {
    console.error(`[knocoph] Detected change in ${absolutePath}`);
    const existing = pending.get(absolutePath);
    if (existing !== undefined) clearTimeout(existing);
    pending.set(
      absolutePath,
      setTimeout(() => {
        pending.delete(absolutePath);

        // Index the primary file that changed
        const result = indexFile(db, absolutePath, pathAliases);
        console.error(
          `[knocoph] Re-indexed ${absolutePath} (${result.status})`
        );

        // Ripple invalidation: re-index files that import this one
        const importers = getImportersOf(db, absolutePath);
        if (importers.length > 20) {
          console.error(
            `[knocoph] Skipping ripple for ${absolutePath} (${importers.length} importers > 20 limit)`
          );
        } else if (importers.length > 0) {
          console.error(
            `[knocoph] Ripple invalidating ${importers.length} importer(s) of ${absolutePath}`
          );

          // Schedule importers to be re-indexed after longer delay (1000ms > 500ms)
          for (const importerPath of importers) {
            const existingImporter = pending.get(importerPath);
            if (existingImporter !== undefined) clearTimeout(existingImporter);
            pending.set(
              importerPath,
              setTimeout(() => {
                pending.delete(importerPath);
                indexFile(db, importerPath, pathAliases);
              }, 1000) // Longer delay for ripple
            );
          }
        }
      }, 500)
    );
  };

  // chokidar v5: the `ignored` option takes a function, not glob strings.
  // The function receives (path, stats?) — return true to ignore.
  // Files: ignore if extension is not in allowedExtensions.
  // Directories: ignore if the directory name is in ignoredDirs.
  const watcher = chokidar.watch(rootDir, {
    ignored: (filePath: string, stats?: Stats) => {
      const basename = path.basename(filePath);
      // Always ignore dotfiles/dotdirs (e.g. .git, .knocoph)
      if (basename.startsWith(".")) return true;
      // Ignore known directories by name
      if (stats?.isDirectory()) return ignoredDirs.has(basename);
      // Ignore files with non-matching extensions
      if (stats?.isFile()) {
        if (allowedExtensions.size === 0) return false;
        return !allowedExtensions.has(path.extname(filePath));
      }
      return false;
    },
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: true,
  });

  watcher
    .on("add", handleChange)
    .on("change", handleChange)
    .on("unlink", (absolutePath: string) => {
      deleteFile(db, absolutePath);
    })
    .on("error", (err: unknown) => {
      console.error("[knocoph] Watcher error:", err);
    })
    .on("ready", () => {
      console.error("[knocoph] Watcher ready — watching for changes");
    });

  activeWatcher = watcher;
  console.error("[knocoph] Watcher started for", rootDir);
}
