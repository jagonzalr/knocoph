import type { TSESTree } from "@typescript-eslint/typescript-estree";

import type { PathAliases } from "../types.js";
import { resolveImportPath } from "./resolve-import.js";

export type SymbolEntry = { resolvedName: string; sourceFile: string };

// Pass 1 — collect imported names (aliased and direct).
// Pass 2 — collect top-level local declaration names.
// Both resolve to an entry that says "this local name means resolvedName from sourceFile".
// sourceFile is the resolved absolute path for relative imports, the raw specifier for
// external packages, or the current filePath for locally declared symbols.
export function buildSymbolTable(
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
          if (declarator.id.type !== "Identifier") continue;
          // Constructor assignment: const svc = new UserService()
          // Map the variable to the class name's resolved entry.
          if (
            declarator.init?.type === "NewExpression" &&
            declarator.init.callee.type === "Identifier"
          ) {
            const className = declarator.init.callee.name;
            const classEntry = table.get(className);
            if (classEntry) {
              table.set(declarator.id.name, {
                resolvedName: classEntry.resolvedName,
                sourceFile: classEntry.sourceFile,
              });
              continue;
            }
          }
          table.set(declarator.id.name, {
            resolvedName: declarator.id.name,
            sourceFile: filePath,
          });
        }
        break;
    }
  }

  // Pass 2b — typed parameters: function handler(svc: UserService) {}
  // Maps parameter names to the type's resolved entry when the type annotation
  // is a simple TSTypeReference with an Identifier that exists in the table.
  for (const stmt of ast.body) {
    const decl =
      stmt.type === "ExportNamedDeclaration" ? stmt.declaration : stmt;
    if (!decl) continue;

    let params: TSESTree.Parameter[] | undefined;
    if (decl.type === "FunctionDeclaration" && decl.params) {
      params = decl.params;
    }
    if (decl.type === "VariableDeclaration") {
      for (const declarator of decl.declarations) {
        if (declarator.init?.type === "ArrowFunctionExpression") {
          params = declarator.init.params;
        }
      }
    }

    if (params) {
      for (const param of params) {
        if (
          param.type === "Identifier" &&
          param.typeAnnotation?.type === "TSTypeAnnotation" &&
          param.typeAnnotation.typeAnnotation.type === "TSTypeReference" &&
          param.typeAnnotation.typeAnnotation.typeName.type === "Identifier"
        ) {
          const typeName = param.typeAnnotation.typeAnnotation.typeName.name;
          const typeEntry = table.get(typeName);
          if (typeEntry) {
            table.set(param.name, {
              resolvedName: typeEntry.resolvedName,
              sourceFile: typeEntry.sourceFile,
            });
          }
        }
      }
    }
  }

  return table;
}
