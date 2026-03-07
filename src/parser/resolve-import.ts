import * as fs from "node:fs";
import * as path from "node:path";

import type { PathAliases } from "../types.js";

// Resolve a non-relative specifier against tsconfig compilerOptions.paths.
// Supports:
//   - Wildcard patterns: "@scope/*" -> "./src/*"  (prefix replacement)
//   - Exact patterns:    "@auth"    -> "./src/auth/index.ts"
// Complex patterns with multiple wildcards or non-prefix wildcards are not
// supported and are skipped. Only the first replacement in each array is used.
// Returns the resolved absolute path on match, or null if no pattern matches.
function resolvePathAlias(
  specifier: string,
  pathAliases: PathAliases
): string | null {
  const { baseDir, paths } = pathAliases;

  for (const [pattern, replacements] of Object.entries(paths)) {
    if (!replacements.length) continue;
    const replacement = replacements[0]!;

    if (pattern.endsWith("/*")) {
      // Wildcard: "@scope/*" — match specifiers starting with "@scope/"
      const patternPrefix = pattern.slice(0, -2);
      if (!specifier.startsWith(patternPrefix + "/")) continue;
      const rest = specifier.slice(patternPrefix.length + 1);
      const replacementBase = replacement.endsWith("/*")
        ? replacement.slice(0, -2)
        : replacement;
      return probeExtensions(path.resolve(baseDir, replacementBase, rest));
    } else {
      // Exact: "@auth" — must be an identical match
      if (specifier !== pattern) continue;
      return probeExtensions(path.resolve(baseDir, replacement));
    }
  }

  return null;
}

// Probe common TypeScript file existence variants for a candidate path.
// Returns the first path that exists on disk, or candidate as-is (dangling).
// When the candidate is an existing directory, checks for index.ts / index.tsx
// inside it (common TypeScript barrel import pattern).
export function probeExtensions(candidate: string): string {
  if (fs.existsSync(candidate)) {
    // Directory: look for an index file inside it.
    if (fs.statSync(candidate).isDirectory()) {
      const indexTs = path.join(candidate, "index.ts");
      if (fs.existsSync(indexTs)) return indexTs;
      const indexTsx = path.join(candidate, "index.tsx");
      if (fs.existsSync(indexTsx)) return indexTsx;
      // No index file — return directory as-is (dangling edge is allowed).
      return candidate;
    }
    return candidate; // regular file
  }
  const ts = candidate + ".ts";
  if (fs.existsSync(ts)) return ts;
  const tsx = candidate + ".tsx";
  if (fs.existsSync(tsx)) return tsx;
  const indexTs = path.join(candidate, "index.ts");
  if (fs.existsSync(indexTs)) return indexTs;
  const indexTsx = path.join(candidate, "index.tsx");
  if (fs.existsSync(indexTsx)) return indexTsx;
  return candidate;
}

// Resolve an import specifier to an absolute file path.
//
// - Non-relative specifiers: path alias resolution via pathAliases (if
//   provided), then fallback to returning the specifier as-is (external module).
// - Relative specifiers: standard path.resolve, with TypeScript extension
//   remapping (.js → .ts, .mjs → .mts, .cjs → .cts) when the raw path does
//   not exist on disk.
export function resolveImportPath(
  fromFile: string,
  specifier: string,
  pathAliases?: PathAliases
): string {
  if (!specifier.startsWith(".")) {
    // Non-relative — try path alias resolution, then treat as external module.
    if (pathAliases) {
      const aliased = resolvePathAlias(specifier, pathAliases);
      if (aliased !== null) return aliased;
    }
    return specifier;
  }

  const raw = path.resolve(path.dirname(fromFile), specifier);
  if (fs.existsSync(raw)) return raw;

  // .js → .ts / .tsx
  if (raw.endsWith(".js")) {
    const ts = raw.slice(0, -3) + ".ts";
    if (fs.existsSync(ts)) return ts;
    const tsx = raw.slice(0, -3) + ".tsx";
    if (fs.existsSync(tsx)) return tsx;
  }
  // .mjs → .mts
  if (raw.endsWith(".mjs")) {
    const mts = raw.slice(0, -4) + ".mts";
    if (fs.existsSync(mts)) return mts;
  }
  // .cjs → .cts
  if (raw.endsWith(".cjs")) {
    const cts = raw.slice(0, -4) + ".cts";
    if (fs.existsSync(cts)) return cts;
  }

  // No matching file found — return the raw resolved path. The edge will dangle,
  // which is explicitly allowed by the schema design (section 9.3).
  return raw;
}
