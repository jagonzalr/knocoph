import * as path from "node:path";

import { parse } from "@typescript-eslint/typescript-estree";
import type { TSESTree } from "@typescript-eslint/typescript-estree";

import type {
  NodeKind,
  ParsedEdge,
  ParsedFile,
  ParsedNode,
  PathAliases,
} from "../types.js";
import { collectCallEdges, collectReferenceEdges } from "./collect-edges.js";
import { nodeId } from "./node-id.js";
import { resolveImportPath } from "./resolve-import.js";
import { buildSymbolTable } from "./symbol-table.js";
import { walk } from "./walk.js";

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
