import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { parse } from "@typescript-eslint/typescript-estree";
import type { TSESTree } from "@typescript-eslint/typescript-estree";

import type {
  NodeKind,
  ParsedEdge,
  ParsedFile,
  ParsedNode,
  PathAliases,
} from "./types.js";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function nodeId(filePath: string, name: string, kind: string): string {
  return createHash("sha256")
    .update(filePath + ":" + name + ":" + kind)
    .digest("hex");
}

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
function probeExtensions(candidate: string): string {
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
function resolveImportPath(
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

type SymbolEntry = { resolvedName: string; sourceFile: string };

// Pass 1 — collect imported names (aliased and direct).
// Pass 2 — collect top-level local declaration names.
// Both resolve to an entry that says "this local name means resolvedName from sourceFile".
// sourceFile is the resolved absolute path for relative imports, the raw specifier for
// external packages, or the current filePath for locally declared symbols.
function buildSymbolTable(
  ast: TSESTree.Program,
  filePath: string,
  pathAliases?: PathAliases
): Map<string, SymbolEntry> {
  const table = new Map<string, SymbolEntry>();

  // Pass 1 — imports
  for (const stmt of ast.body) {
    if (stmt.type !== "ImportDeclaration") continue;
    const raw = stmt.source.value;
    const sourceFile = resolveImportPath(filePath, raw, pathAliases);

    for (const specifier of stmt.specifiers) {
      if (specifier.type === "ImportDefaultSpecifier") {
        table.set(specifier.local.name, {
          resolvedName: "default",
          sourceFile,
        });
      } else if (specifier.type === "ImportNamespaceSpecifier") {
        table.set(specifier.local.name, { resolvedName: "*", sourceFile });
      } else if (specifier.type === "ImportSpecifier") {
        const imported =
          specifier.imported.type === "Identifier"
            ? specifier.imported.name
            : specifier.imported.value;
        table.set(specifier.local.name, {
          resolvedName: imported,
          sourceFile,
        });
      }
    }
  }

  // Pass 2 — local top-level declarations
  for (const stmt of ast.body) {
    const decl =
      stmt.type === "ExportNamedDeclaration" ? stmt.declaration : stmt;
    if (!decl) continue;

    switch (decl.type) {
      case "FunctionDeclaration":
        if (decl.id) {
          table.set(decl.id.name, {
            resolvedName: decl.id.name,
            sourceFile: filePath,
          });
        }
        break;
      case "ClassDeclaration":
        if (decl.id) {
          table.set(decl.id.name, {
            resolvedName: decl.id.name,
            sourceFile: filePath,
          });
        }
        break;
      case "TSInterfaceDeclaration":
        table.set(decl.id.name, {
          resolvedName: decl.id.name,
          sourceFile: filePath,
        });
        break;
      case "TSTypeAliasDeclaration":
        table.set(decl.id.name, {
          resolvedName: decl.id.name,
          sourceFile: filePath,
        });
        break;
      case "TSEnumDeclaration":
        table.set(decl.id.name, {
          resolvedName: decl.id.name,
          sourceFile: filePath,
        });
        break;
      case "TSModuleDeclaration":
        if (decl.id.type === "Identifier") {
          table.set(decl.id.name, {
            resolvedName: decl.id.name,
            sourceFile: filePath,
          });
        }
        break;
      case "VariableDeclaration":
        for (const declarator of decl.declarations) {
          if (declarator.id.type === "Identifier") {
            table.set(declarator.id.name, {
              resolvedName: declarator.id.name,
              sourceFile: filePath,
            });
          }
        }
        break;
    }
  }

  return table;
}

// Generic recursive AST walk. Calls visitor on every node.
function walk(node: TSESTree.Node, visitor: (n: TSESTree.Node) => void): void {
  visitor(node);
  for (const value of Object.values(node)) {
    if (value === null || typeof value !== "object") continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item !== null && typeof item === "object" && "type" in item) {
          walk(item as TSESTree.Node, visitor);
        }
      }
    } else if ("type" in value) {
      walk(value as TSESTree.Node, visitor);
    }
  }
}

// ---------------------------------------------------------------------------
// Node extraction helpers
// ---------------------------------------------------------------------------

function makeParsedNode(
  id: string,
  name: string,
  kind: NodeKind,
  filePath: string,
  astNode: { loc?: TSESTree.SourceLocation | null },
  exported: 0 | 1
): ParsedNode {
  return {
    id,
    name,
    kind,
    file_path: filePath,
    start_line: astNode.loc?.start.line ?? 1,
    end_line: astNode.loc?.end.line ?? 1,
    exported,
  };
}

// ---------------------------------------------------------------------------
// Call edge resolution (Pass 3)
// ---------------------------------------------------------------------------

// Collect CALLS edges from within a function/method body AST node.
// localNodesMap: name -> ParsedNode for all nodes in the current file.
function collectCallEdges(
  bodyAstNode: TSESTree.Node,
  currentId: string,
  symbolTable: Map<string, SymbolEntry>,
  localNodesMap: Map<string, ParsedNode>,
  filePath: string,
  edges: ParsedEdge[]
): void {
  walk(bodyAstNode, (n) => {
    if (n.type !== "CallExpression") return;

    const callee = n.callee;

    if (callee.type === "Identifier") {
      // Direct call: foo()
      const entry = symbolTable.get(callee.name);
      if (!entry) return;
      const targetFile =
        entry.sourceFile === filePath ? filePath : entry.sourceFile;
      // Try 'function' kind first, then 'method', then 'arrow_function'
      // The target may differ in kind — use 'function' as the canonical guess
      // for imported top-level symbols and 'function' for local ones.
      const targetKind =
        localNodesMap.has(entry.resolvedName) &&
        localNodesMap.get(entry.resolvedName)?.kind !== undefined
          ? localNodesMap.get(entry.resolvedName)!.kind
          : "function";
      const targetId = nodeId(targetFile, entry.resolvedName, targetKind);
      edges.push({
        source_id: currentId,
        target_id: targetId,
        relationship_type: "CALLS",
      });
    } else if (callee.type === "MemberExpression") {
      const obj = callee.object;
      const prop = callee.property;
      if (prop.type !== "Identifier") return;

      if (obj.type === "ThisExpression") {
        // this.method() — look up method by name in current file's local nodes
        const localNode =
          localNodesMap.get(prop.name) ??
          // Also search by kind if the map has multiple entries —
          // localNodesMap is keyed by name, so get() is sufficient.
          undefined;
        if (localNode) {
          edges.push({
            source_id: currentId,
            target_id: localNode.id,
            relationship_type: "CALLS",
          });
        }
      } else if (obj.type === "Identifier") {
        // obj.method() — obj must be an imported name
        const entry = symbolTable.get(obj.name);
        if (!entry || entry.sourceFile === filePath) return;
        const targetId = nodeId(entry.sourceFile, prop.name, "method");
        edges.push({
          source_id: currentId,
          target_id: targetId,
          relationship_type: "CALLS",
        });
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Reference edge collection (Pass 4)
// ---------------------------------------------------------------------------

// Collect REFERENCES edges from within a symbol's AST node by walking for
// TSTypeReference nodes (type annotations). Uses a full walk (not shallow) so
// that type annotations nested inside function bodies, generic parameters, and
// conditional types are all captured.
//
// Known limitation: for cross-file references the target kind is guessed as
// "interface" when the resolved name is not found in localNodesMap. This may
// produce dangling edges when the actual kind is "type_alias", "class", or
// "enum". Accepted per section 5 of the implementation plan; correct kind
// resolution requires the TS compiler API (PR-V2-2).
//
// Note: Identifier walk for value-position references is omitted here because
// reliably distinguishing non-call, non-declaration, non-import identifiers
// requires parent tracking that the current walk helpers do not provide.
function collectReferenceEdges(
  bodyAstNode: TSESTree.Node,
  currentId: string,
  symbolTable: Map<string, SymbolEntry>,
  localNodesMap: Map<string, ParsedNode>,
  filePath: string,
  edges: ParsedEdge[]
): void {
  walk(bodyAstNode, (n) => {
    if (n.type !== "TSTypeReference") return;

    // typeName is Identifier | TSQualifiedName. For qualified names (A.B) we
    // take the leftmost identifier which is the imported namespace/module name.
    const typeName = n.typeName;
    const name =
      typeName.type === "Identifier"
        ? typeName.name
        : typeName.type === "TSQualifiedName" &&
            typeName.left.type === "Identifier"
          ? typeName.left.name
          : null;
    if (!name) return;

    const entry = symbolTable.get(name);
    if (!entry) return;

    const targetFile =
      entry.sourceFile === filePath ? filePath : entry.sourceFile;

    // For local nodes, use the exact id from localNodesMap to guarantee a
    // non-dangling edge. For cross-file nodes, fall back to "interface" as the
    // canonical type kind guess.
    const localNode = localNodesMap.get(entry.resolvedName);
    const targetId = localNode
      ? localNode.id
      : nodeId(targetFile, entry.resolvedName, "interface");

    edges.push({
      source_id: currentId,
      target_id: targetId,
      relationship_type: "REFERENCES",
    });
  });
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export function parseFile(
  filePath: string,
  content: string,
  pathAliases?: PathAliases
): ParsedFile {
  // Let parse errors propagate to the caller (indexer), which catches them and
  // records the file as status 'error' without writing partial data (section 9.1).
  const ast: TSESTree.Program = parse(content, {
    jsx: true,
    loc: true,
    comment: false,
    range: false,
  });

  const symbolTable = buildSymbolTable(ast, filePath, pathAliases);
  const nodes: ParsedNode[] = [];
  const edges: ParsedEdge[] = [];

  // Synthetic file-level node — used as the source for IMPORTS edges and
  // re-export EXPORTS edges. Represents the module boundary.
  const fileBaseName = path.basename(filePath, path.extname(filePath));
  const fileNodeId = nodeId(filePath, fileBaseName, "namespace");
  let fileNodeNeeded = false;

  // Maps method/function name -> ParsedNode for this file,
  // used in this.method() resolution.
  const localNodesMap = new Map<string, ParsedNode>();

  // Pairs of (ParsedNode, AST node) so we can resolve CALLS after all nodes
  // are extracted.
  type NodeAstPair = { parsed: ParsedNode; ast: TSESTree.Node };
  const callablePairs: NodeAstPair[] = [];

  // Pairs of (ParsedNode, AST node) for the REFERENCES pass (Pass 4). Includes
  // ALL top-level symbols — callables and non-callables — so that type
  // annotations on interfaces, type aliases, and plain variable declarations
  // are captured. Class bodies are excluded here; each class method is listed
  // individually (same as callablePairs) to attribute references to the correct
  // method scope rather than the class as a whole.
  const referenceAstPairs: NodeAstPair[] = [];

  // -------------------------------------------------------------------------
  // Extract nodes from top-level statements
  // -------------------------------------------------------------------------

  function extractExported(
    exported: 0 | 1,
    decl:
      | TSESTree.FunctionDeclaration
      | TSESTree.ClassDeclaration
      | TSESTree.TSInterfaceDeclaration
      | TSESTree.TSTypeAliasDeclaration
      | TSESTree.TSEnumDeclaration
      | TSESTree.TSModuleDeclaration
      | TSESTree.VariableDeclaration
      | null
      | undefined
  ): void {
    if (!decl) return;

    switch (decl.type) {
      case "FunctionDeclaration": {
        if (!decl.id) break;
        const n = makeParsedNode(
          nodeId(filePath, decl.id.name, "function"),
          decl.id.name,
          "function",
          filePath,
          decl,
          exported
        );
        nodes.push(n);
        localNodesMap.set(n.name, n);
        callablePairs.push({ parsed: n, ast: decl });
        referenceAstPairs.push({ parsed: n, ast: decl });
        break;
      }
      case "ClassDeclaration": {
        if (!decl.id) break;
        const classNode = makeParsedNode(
          nodeId(filePath, decl.id.name, "class"),
          decl.id.name,
          "class",
          filePath,
          decl,
          exported
        );
        nodes.push(classNode);
        localNodesMap.set(classNode.name, classNode);

        // EXTENDS edge
        if (decl.superClass && decl.superClass.type === "Identifier") {
          const superName = decl.superClass.name;
          const superEntry = symbolTable.get(superName);
          const superFile = superEntry ? superEntry.sourceFile : filePath;
          const superResolvedName = superEntry
            ? superEntry.resolvedName
            : superName;
          edges.push({
            source_id: classNode.id,
            target_id: nodeId(superFile, superResolvedName, "class"),
            relationship_type: "EXTENDS",
          });
        }

        // IMPLEMENTS edges
        if (decl.implements) {
          for (const impl of decl.implements) {
            const expr = impl.expression;
            if (expr.type === "Identifier") {
              const implEntry = symbolTable.get(expr.name);
              const implFile = implEntry ? implEntry.sourceFile : filePath;
              const implName = implEntry ? implEntry.resolvedName : expr.name;
              edges.push({
                source_id: classNode.id,
                target_id: nodeId(implFile, implName, "interface"),
                relationship_type: "IMPLEMENTS",
              });
            }
          }
        }

        // Class members — methods and constructor
        for (const member of decl.body.body) {
          if (member.type !== "MethodDefinition") continue;
          if (member.key.type !== "Identifier") continue;
          const methodName = member.key.name;
          const isConstructor = member.kind === "constructor";
          const memberKind: NodeKind = isConstructor ? "constructor" : "method";
          const memberNode = makeParsedNode(
            nodeId(filePath, methodName, memberKind),
            methodName,
            memberKind,
            filePath,
            member,
            0 // class members are not independently exported
          );
          nodes.push(memberNode);
          localNodesMap.set(methodName, memberNode);

          // CONTAINS edge: class -> method/constructor
          edges.push({
            source_id: classNode.id,
            target_id: memberNode.id,
            relationship_type: "CONTAINS",
          });

          callablePairs.push({ parsed: memberNode, ast: member.value });
          referenceAstPairs.push({ parsed: memberNode, ast: member.value });
        }
        break;
      }
      case "TSInterfaceDeclaration": {
        const n = makeParsedNode(
          nodeId(filePath, decl.id.name, "interface"),
          decl.id.name,
          "interface",
          filePath,
          decl,
          exported
        );
        nodes.push(n);
        localNodesMap.set(n.name, n);
        referenceAstPairs.push({ parsed: n, ast: decl });
        break;
      }
      case "TSTypeAliasDeclaration": {
        const n = makeParsedNode(
          nodeId(filePath, decl.id.name, "type_alias"),
          decl.id.name,
          "type_alias",
          filePath,
          decl,
          exported
        );
        nodes.push(n);
        localNodesMap.set(n.name, n);
        referenceAstPairs.push({ parsed: n, ast: decl });
        break;
      }
      case "TSEnumDeclaration": {
        const n = makeParsedNode(
          nodeId(filePath, decl.id.name, "enum"),
          decl.id.name,
          "enum",
          filePath,
          decl,
          exported
        );
        nodes.push(n);
        localNodesMap.set(n.name, n);
        referenceAstPairs.push({ parsed: n, ast: decl });
        break;
      }
      case "TSModuleDeclaration": {
        if (decl.id.type !== "Identifier") break;
        const n = makeParsedNode(
          nodeId(filePath, decl.id.name, "namespace"),
          decl.id.name,
          "namespace",
          filePath,
          decl,
          exported
        );
        nodes.push(n);
        localNodesMap.set(n.name, n);
        referenceAstPairs.push({ parsed: n, ast: decl });
        break;
      }
      case "VariableDeclaration": {
        for (const declarator of decl.declarations) {
          if (declarator.id.type !== "Identifier") continue;
          const varName = declarator.id.name;
          const isArrow = declarator.init?.type === "ArrowFunctionExpression";
          const kind: NodeKind = isArrow ? "arrow_function" : "variable";
          const n = makeParsedNode(
            nodeId(filePath, varName, kind),
            varName,
            kind,
            filePath,
            declarator,
            exported
          );
          nodes.push(n);
          localNodesMap.set(n.name, n);
          if (isArrow && declarator.init) {
            callablePairs.push({ parsed: n, ast: declarator.init });
            referenceAstPairs.push({ parsed: n, ast: declarator.init });
          } else {
            referenceAstPairs.push({ parsed: n, ast: declarator });
          }
        }
        break;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Process top-level statements
  // -------------------------------------------------------------------------

  for (const stmt of ast.body) {
    switch (stmt.type) {
      case "ImportDeclaration": {
        // IMPORTS edge: file-level node -> resolved path (or external module name)
        const raw = stmt.source.value;
        const target = resolveImportPath(filePath, raw, pathAliases);
        fileNodeNeeded = true;
        edges.push({
          source_id: fileNodeId,
          target_id: target,
          relationship_type: "IMPORTS",
        });
        break;
      }

      case "ExportNamedDeclaration": {
        if (stmt.source) {
          // Re-export: export { foo as bar } from './x.js'
          const raw = stmt.source.value;
          const resolvedSource = resolveImportPath(filePath, raw, pathAliases);
          fileNodeNeeded = true;

          // IMPORTS edge
          edges.push({
            source_id: fileNodeId,
            target_id: resolvedSource,
            relationship_type: "IMPORTS",
          });

          // EXPORTS edge for each specifier
          for (const specifier of stmt.specifiers) {
            if (specifier.type !== "ExportSpecifier") continue;
            if (specifier.local.type !== "Identifier") continue;
            const localName = specifier.local.name;
            // Kind is unknown at re-export time (we'd need to re-parse source)
            // "unknown" is a documented deliberate imprecision (section 9.5)
            const targetId = nodeId(resolvedSource, localName, "unknown");
            edges.push({
              source_id: fileNodeId,
              target_id: targetId,
              relationship_type: "EXPORTS",
            });
          }
        } else if (stmt.declaration) {
          extractExported(
            1,
            stmt.declaration as Parameters<typeof extractExported>[1]
          );
        }
        // ExportNamedDeclaration with only specifiers (no source, no declaration)
        // e.g. export { foo, bar } — mark already-extracted nodes as exported
        else if (stmt.specifiers.length > 0) {
          for (const specifier of stmt.specifiers) {
            if (specifier.type !== "ExportSpecifier") continue;
            if (specifier.local.type !== "Identifier") continue;
            const localName = specifier.local.name;
            const existingNode = localNodesMap.get(localName);
            if (existingNode) {
              existingNode.exported = 1;
            }
          }
        }
        break;
      }

      case "ExportDefaultDeclaration": {
        const decl = stmt.declaration;
        if (
          decl.type === "FunctionDeclaration" ||
          decl.type === "ClassDeclaration"
        ) {
          extractExported(1, decl);
        }
        break;
      }

      case "ExportAllDeclaration": {
        // export * from './x.js' — emit IMPORTS edge only (EXPORTS is not tracked per-symbol)
        if (stmt.source) {
          const raw = stmt.source.value;
          const target = resolveImportPath(filePath, raw, pathAliases);
          fileNodeNeeded = true;
          edges.push({
            source_id: fileNodeId,
            target_id: target,
            relationship_type: "IMPORTS",
          });
        }
        break;
      }

      case "FunctionDeclaration":
      case "ClassDeclaration":
      case "TSInterfaceDeclaration":
      case "TSTypeAliasDeclaration":
      case "TSEnumDeclaration":
      case "TSModuleDeclaration":
      case "VariableDeclaration":
        extractExported(0, stmt as Parameters<typeof extractExported>[1]);
        break;
    }
  }

  // -------------------------------------------------------------------------
  // Dynamic imports: import('./x.js') anywhere in the file
  // -------------------------------------------------------------------------
  walk(ast, (n) => {
    if (n.type !== "ImportExpression") return;
    const source = (n as TSESTree.ImportExpression).source;
    if (source.type !== "Literal" || typeof source.value !== "string") {
      console.error("[knocoph] unresolvable dynamic import in " + filePath);
      return;
    }
    const target = resolveImportPath(filePath, source.value, pathAliases);
    fileNodeNeeded = true;
    edges.push({
      source_id: fileNodeId,
      target_id: target,
      relationship_type: "IMPORTS",
    });
  });

  // -------------------------------------------------------------------------
  // CALLS edges — Pass 3
  // -------------------------------------------------------------------------
  for (const { parsed, ast: bodyAst } of callablePairs) {
    collectCallEdges(
      bodyAst,
      parsed.id,
      symbolTable,
      localNodesMap,
      filePath,
      edges
    );
  }

  // -------------------------------------------------------------------------
  // REFERENCES edges — Pass 4
  // -------------------------------------------------------------------------
  for (const { parsed, ast: bodyAst } of referenceAstPairs) {
    collectReferenceEdges(
      bodyAst,
      parsed.id,
      symbolTable,
      localNodesMap,
      filePath,
      edges
    );
  }

  // -------------------------------------------------------------------------
  // Add file-level node if it was referenced as a source for any edge
  // -------------------------------------------------------------------------
  if (fileNodeNeeded) {
    const fileNode: ParsedNode = {
      id: fileNodeId,
      name: fileBaseName,
      kind: "namespace",
      file_path: filePath,
      start_line: 1,
      end_line: ast.loc?.end.line ?? 1,
      exported: 0,
    };
    // Prepend so file node appears first
    nodes.unshift(fileNode);
  }

  // Deduplicate edges (same source/target/type may appear from different passes)
  const seen = new Set<string>();
  const dedupedEdges: ParsedEdge[] = [];
  for (const edge of edges) {
    const key = `${edge.source_id}|${edge.target_id}|${edge.relationship_type}`;
    if (!seen.has(key)) {
      seen.add(key);
      dedupedEdges.push(edge);
    }
  }

  return { nodes, edges: dedupedEdges };
}
