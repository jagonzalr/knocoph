import type { TSESTree } from "@typescript-eslint/typescript-estree";

// Generic recursive AST walk. Calls visitor on every node.
export function walk(
  node: TSESTree.Node,
  visitor: (n: TSESTree.Node) => void
): void {
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
