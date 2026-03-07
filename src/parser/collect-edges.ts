import type { TSESTree } from "@typescript-eslint/typescript-estree";

import type { ParsedEdge, ParsedNode } from "../types.js";
import { nodeId } from "./node-id.js";
import type { SymbolEntry } from "./symbol-table.js";
import { walk } from "./walk.js";

// ---------------------------------------------------------------------------
// Call edge resolution (Pass 3)
// ---------------------------------------------------------------------------

// Collect CALLS edges from within a function/method body AST node.
// localNodesMap: name -> ParsedNode for all nodes in the current file.
export function collectCallEdges(
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
        // obj.method() — obj is either an imported name or a local variable
        // mapped to a class/interface via constructor assignment or type annotation.
        const entry = symbolTable.get(obj.name);
        if (!entry) return;

        if (entry.sourceFile !== filePath) {
          // Imported module: resolve method on the imported file
          const targetId = nodeId(entry.sourceFile, prop.name, "method");
          edges.push({
            source_id: currentId,
            target_id: targetId,
            relationship_type: "CALLS",
          });
        } else if (entry.resolvedName !== obj.name) {
          // Local type-mapped variable (e.g., const svc = new UserService()).
          // entry.resolvedName is the class name, look it up to find its source.
          const classEntry = symbolTable.get(entry.resolvedName);
          const targetFile = classEntry ? classEntry.sourceFile : filePath;
          const targetId = nodeId(targetFile, prop.name, "method");
          edges.push({
            source_id: currentId,
            target_id: targetId,
            relationship_type: "CALLS",
          });
        }
        // else: entry.resolvedName === obj.name and sourceFile === filePath
        // — a plain local variable, not a type mapping. Skip.
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
export function collectReferenceEdges(
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
