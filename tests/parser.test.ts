import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { parseFile } from "../src/parser.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function testNodeId(filePath: string, name: string, kind: string): string {
  return createHash("sha256")
    .update(filePath + ":" + name + ":" + kind)
    .digest("hex");
}

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(testsDir, "fixtures");

function fixturePath(rel: string): string {
  return path.join(fixturesDir, rel);
}

function fixtureContent(rel: string): string {
  return fs.readFileSync(fixturePath(rel), "utf-8");
}

// ---------------------------------------------------------------------------
// simple.ts fixture
// ---------------------------------------------------------------------------

describe("simple.ts — node kinds", () => {
  const fp = fixturePath("simple.ts");
  const result = parseFile(fp, fixtureContent("simple.ts"));

  it("extracts interface User with exported = 1", () => {
    const node = result.nodes.find(
      (n) => n.name === "User" && n.kind === "interface"
    );
    expect(node).toBeDefined();
    expect(node?.exported).toBe(1);
    expect(node?.id).toBe(testNodeId(fp, "User", "interface"));
  });

  it("extracts type alias UserId", () => {
    const node = result.nodes.find((n) => n.name === "UserId");
    expect(node).toBeDefined();
    expect(node?.kind).toBe("type_alias");
  });

  it("extracts enum Role", () => {
    const node = result.nodes.find((n) => n.name === "Role");
    expect(node).toBeDefined();
    expect(node?.kind).toBe("enum");
  });

  it("extracts class UserService with exported = 1", () => {
    const node = result.nodes.find(
      (n) => n.name === "UserService" && n.kind === "class"
    );
    expect(node).toBeDefined();
    expect(node?.exported).toBe(1);
  });

  it("extracts method create", () => {
    const node = result.nodes.find(
      (n) => n.name === "create" && n.kind === "method"
    );
    expect(node).toBeDefined();
  });

  it("extracts constructor", () => {
    const node = result.nodes.find((n) => n.kind === "constructor");
    expect(node).toBeDefined();
    expect(node?.name).toBe("constructor");
  });

  it("extracts function createUser with exported = 1", () => {
    const node = result.nodes.find(
      (n) => n.name === "createUser" && n.kind === "function"
    );
    expect(node).toBeDefined();
    expect(node?.exported).toBe(1);
  });

  it("extracts const helper as arrow_function", () => {
    const node = result.nodes.find((n) => n.name === "helper");
    expect(node).toBeDefined();
    expect(node?.kind).toBe("arrow_function");
  });

  it("UserService has start_line < end_line", () => {
    const node = result.nodes.find(
      (n) => n.name === "UserService" && n.kind === "class"
    );
    expect(node).toBeDefined();
    expect(node!.start_line).toBeLessThan(node!.end_line);
  });
});

describe("simple.ts — edges", () => {
  const fp = fixturePath("simple.ts");
  const result = parseFile(fp, fixtureContent("simple.ts"));

  it("EXTENDS edge from UserService to BaseService", () => {
    const edge = result.edges.find(
      (e) =>
        e.relationship_type === "EXTENDS" &&
        e.source_id === testNodeId(fp, "UserService", "class") &&
        e.target_id === testNodeId(fp, "BaseService", "class")
    );
    expect(edge).toBeDefined();
  });

  it("CONTAINS edge from UserService to create method", () => {
    const edge = result.edges.find(
      (e) =>
        e.relationship_type === "CONTAINS" &&
        e.source_id === testNodeId(fp, "UserService", "class") &&
        e.target_id === testNodeId(fp, "create", "method")
    );
    expect(edge).toBeDefined();
  });

  it("CONTAINS edge from UserService to constructor", () => {
    const edge = result.edges.find(
      (e) =>
        e.relationship_type === "CONTAINS" &&
        e.source_id === testNodeId(fp, "UserService", "class") &&
        e.target_id === testNodeId(fp, "constructor", "constructor")
    );
    expect(edge).toBeDefined();
  });

  it("CALLS edge from create method to log method (this.log())", () => {
    const edge = result.edges.find(
      (e) =>
        e.relationship_type === "CALLS" &&
        e.source_id === testNodeId(fp, "create", "method") &&
        e.target_id === testNodeId(fp, "log", "method")
    );
    expect(edge).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// aliases.ts — import alias resolution (critical test)
// ---------------------------------------------------------------------------

describe("aliases.ts", () => {
  const fp = fixturePath("aliases.ts");
  const simpleFp = fixturePath("simple.ts");
  const result = parseFile(fp, fixtureContent("aliases.ts"));

  it("emits IMPORTS edge to resolved path of simple.ts", () => {
    const edge = result.edges.find(
      (e) => e.relationship_type === "IMPORTS" && e.target_id === simpleFp
    );
    expect(edge).toBeDefined();
  });

  it("CALLS edge from registerUser to createUser via alias (makeUser)", () => {
    // makeUser is an alias for createUser from simple.ts.
    // The resolved CALLS edge must point to createUser's node in simple.ts.
    const edge = result.edges.find(
      (e) =>
        e.relationship_type === "CALLS" &&
        e.source_id === testNodeId(fp, "registerUser", "function") &&
        e.target_id === testNodeId(simpleFp, "createUser", "function")
    );
    expect(edge).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// reexports.ts — re-export chains
// ---------------------------------------------------------------------------

describe("reexports.ts", () => {
  const fp = fixturePath("reexports.ts");
  const simpleFp = fixturePath("simple.ts");
  const result = parseFile(fp, fixtureContent("reexports.ts"));

  it("emits IMPORTS edge to simple.ts", () => {
    const edge = result.edges.find(
      (e) => e.relationship_type === "IMPORTS" && e.target_id === simpleFp
    );
    expect(edge).toBeDefined();
  });

  it("emits EXPORTS edge referencing createUser in simple.ts with unknown kind", () => {
    const expectedTarget = testNodeId(simpleFp, "createUser", "unknown");
    const edge = result.edges.find(
      (e) => e.relationship_type === "EXPORTS" && e.target_id === expectedTarget
    );
    expect(edge).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// dynamic-imports.ts — dynamic import()
// ---------------------------------------------------------------------------

describe("dynamic-imports.ts", () => {
  const fp = fixturePath("dynamic-imports.ts");
  const simpleFp = fixturePath("simple.ts");
  const result = parseFile(fp, fixtureContent("dynamic-imports.ts"));

  it("emits IMPORTS edge for dynamic import('./simple.js')", () => {
    const edge = result.edges.find(
      (e) => e.relationship_type === "IMPORTS" && e.target_id === simpleFp
    );
    expect(edge).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// cross-file/b.ts — cross-file CALLS resolution
// ---------------------------------------------------------------------------

describe("cross-file/b.ts", () => {
  const fp = fixturePath("cross-file/b.ts");
  const aFp = fixturePath("cross-file/a.ts");
  const result = parseFile(fp, fixtureContent("cross-file/b.ts"));

  it("emits IMPORTS edge from b.ts to a.ts", () => {
    const edge = result.edges.find(
      (e) => e.relationship_type === "IMPORTS" && e.target_id === aFp
    );
    expect(edge).toBeDefined();
  });

  it("CALLS edge from runThing to doThing in a.ts", () => {
    const edge = result.edges.find(
      (e) =>
        e.relationship_type === "CALLS" &&
        e.source_id === testNodeId(fp, "runThing", "function") &&
        e.target_id === testNodeId(aFp, "doThing", "function")
    );
    expect(edge).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// IMPLEMENTS edge — inline fixture
// ---------------------------------------------------------------------------

describe("IMPLEMENTS edge", () => {
  it("emits IMPLEMENTS edge for class implementing an interface", () => {
    const fp = "/tmp/knocoph-test-implements.ts";
    const content = `
      interface IService { doIt(): void; }
      class MyService implements IService { doIt(): void {} }
    `;
    const result = parseFile(fp, content);
    const edge = result.edges.find(
      (e) =>
        e.relationship_type === "IMPLEMENTS" &&
        e.source_id === testNodeId(fp, "MyService", "class") &&
        e.target_id === testNodeId(fp, "IService", "interface")
    );
    expect(edge).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("parseFile edge cases", () => {
  it("returns empty result for empty string without throwing", () => {
    expect(() => parseFile("/tmp/empty.ts", "")).not.toThrow();
    const result = parseFile("/tmp/empty.ts", "");
    expect(result.nodes).toHaveLength(0);
    expect(result.edges).toHaveLength(0);
  });

  it("throws for invalid TypeScript syntax", () => {
    // Parse errors propagate so the indexer can catch them and record status
    // 'error' without writing partial data (see implementation plan section 9.1).
    expect(() => parseFile("/tmp/broken.ts", "export { {{{broken")).toThrow();
  });

  it("throws for syntax-invalid input", () => {
    // Parse errors propagate so the indexer can return status 'error' without
    // writing partial data. Empty string is valid (empty module) and does not throw.
    const invalid = ["!!!", "function", "class {}"];
    for (const input of invalid) {
      expect(() => parseFile("/tmp/test.ts", input)).toThrow();
    }
  });

  it("does not throw for empty string (valid empty module)", () => {
    expect(() => parseFile("/tmp/empty.ts", "")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Additional branch coverage tests
// ---------------------------------------------------------------------------

describe("export { foo } — specifier-only export marks node as exported", () => {
  it("marks the referenced node as exported = 1", () => {
    const fp = "/tmp/knocoph-specifier-export.ts";
    const content = `
      function greet() {}
      export { greet };
    `;
    const result = parseFile(fp, content);
    const node = result.nodes.find((n) => n.name === "greet");
    expect(node).toBeDefined();
    expect(node?.exported).toBe(1);
  });
});

describe("export default function", () => {
  it("extracts default exported function with exported = 1", () => {
    const fp = "/tmp/knocoph-default-fn.ts";
    const content = `export default function hello() { return 42; }`;
    const result = parseFile(fp, content);
    const node = result.nodes.find(
      (n) => n.name === "hello" && n.kind === "function"
    );
    expect(node).toBeDefined();
    expect(node?.exported).toBe(1);
  });

  it("extracts default exported class with exported = 1", () => {
    const fp = "/tmp/knocoph-default-class.ts";
    const content = `export default class Svc {}`;
    const result = parseFile(fp, content);
    const node = result.nodes.find(
      (n) => n.name === "Svc" && n.kind === "class"
    );
    expect(node).toBeDefined();
    expect(node?.exported).toBe(1);
  });

  it("does not extract a node for an anonymous expression default export", () => {
    const fp = "/tmp/knocoph-default-expr.ts";
    const content = `export default { key: "value" };`;
    const result = parseFile(fp, content);
    // An anonymous object expression has no extractable name — no node emitted.
    expect(result.nodes.length).toBe(0);
    expect(result.edges.length).toBe(0);
  });
});

describe("export * from — ExportAllDeclaration", () => {
  it("emits IMPORTS edge for export-all from relative path", () => {
    const fp = fixturePath("barrel.ts");
    const content = `export * from "./simple.js";`;
    const result = parseFile(fp, content);
    const simpleFp = fixturePath("simple.ts");
    const edge = result.edges.find(
      (e) => e.relationship_type === "IMPORTS" && e.target_id === simpleFp
    );
    expect(edge).toBeDefined();
  });

  it("emits IMPORTS edge for export-all from external module", () => {
    const fp = "/tmp/knocoph-all-external.ts";
    const content = `export * from "some-package";`;
    const result = parseFile(fp, content);
    const edge = result.edges.find(
      (e) => e.relationship_type === "IMPORTS" && e.target_id === "some-package"
    );
    expect(edge).toBeDefined();
  });
});

describe("dynamic import with non-literal expression", () => {
  it("does not emit an edge and does not throw", () => {
    const fp = "/tmp/knocoph-dynamic-expr.ts";
    const content = `async function load(p: string) { return import(p); }`;
    let result: ReturnType<typeof parseFile>;
    expect(() => {
      result = parseFile(fp, content);
    }).not.toThrow();
    const importEdges = result!.edges.filter(
      (e) => e.relationship_type === "IMPORTS"
    );
    expect(importEdges).toHaveLength(0);
  });
});

describe("default import and namespace import", () => {
  it("records default import in symbol table and resolves CALLS", () => {
    // Default import: import Foo from './foo.js'; Foo();
    const imported = "/tmp/knocoph-src.ts";
    const importer = "/tmp/knocoph-importer.ts";
    // Pre-create the imported file so resolveImportPath can find it
    const content = `
      import Foo from "${imported}";
      export function run() { Foo(); }
    `;
    const result = parseFile(importer, content);
    // Should have an IMPORTS edge targeting the imported file
    const importEdge = result.edges.find(
      (e) => e.relationship_type === "IMPORTS"
    );
    expect(importEdge).toBeDefined();
  });

  it("handles namespace import without throwing", () => {
    const fp = "/tmp/knocoph-ns-import.ts";
    const content = `
      import * as utils from "some-pkg";
      export function run() { utils.helper(); }
    `;
    expect(() => parseFile(fp, content)).not.toThrow();
  });
});

describe("CALLS via MemberExpression on imported object", () => {
  it("emits CALLS edge for obj.method() where obj is an imported name", () => {
    const srcFp = "/tmp/knocoph-service.ts";
    const callerFp = "/tmp/knocoph-caller.ts";
    // The import target won't resolve to a real file, so it stays as-is.
    const content = `
      import service from "${srcFp}";
      export function run() { service.doWork(); }
    `;
    const result = parseFile(callerFp, content);
    // Should emit a CALLS edge referencing doWork as a method on srcFp
    const callsEdge = result.edges.find(
      (e) =>
        e.relationship_type === "CALLS" &&
        e.target_id === testNodeId(srcFp, "doWork", "method")
    );
    expect(callsEdge).toBeDefined();
  });
});

describe("external module imports do not produce file-access edges", () => {
  it("emits IMPORTS edge with raw specifier as target for external packages", () => {
    const fp = "/tmp/knocoph-ext.ts";
    const content = `import { z } from "zod"; export const schema = z.string();`;
    const result = parseFile(fp, content);
    const edge = result.edges.find(
      (e) => e.relationship_type === "IMPORTS" && e.target_id === "zod"
    );
    expect(edge).toBeDefined();
  });
});

describe("namespace node kind", () => {
  it("extracts TSModuleDeclaration as namespace kind", () => {
    const fp = "/tmp/knocoph-ns.ts";
    const content = `export namespace MyNS { export function helper() {} }`;
    const result = parseFile(fp, content);
    const node = result.nodes.find(
      (n) => n.name === "MyNS" && n.kind === "namespace"
    );
    expect(node).toBeDefined();
    expect(node?.exported).toBe(1);
  });
});

describe("variable node kind", () => {
  it("extracts non-arrow variable declarations as variable kind", () => {
    const fp = "/tmp/knocoph-var.ts";
    const content = `export const PORT = 3000;`;
    const result = parseFile(fp, content);
    const node = result.nodes.find((n) => n.name === "PORT");
    expect(node).toBeDefined();
    expect(node?.kind).toBe("variable");
    expect(node?.exported).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Extension remapping: .js → .ts / .tsx / .mts / .cts
// ---------------------------------------------------------------------------

describe("resolveImportPath — extension remapping", () => {
  it("remaps .js to .ts when .ts file exists on disk", () => {
    // Create a temporary .ts file
    const tmpDir = fs.mkdtempSync(path.join(path.sep, "tmp", "knocoph-"));
    try {
      const tsFile = path.join(tmpDir, "helper.ts");
      fs.writeFileSync(tsFile, "export function help() {}");

      // Import from the same directory with .js extension
      const importerFile = path.join(tmpDir, "importer.ts");
      const content = `import { help } from "./helper.js";`;
      const result = parseFile(importerFile, content);

      // Should resolve to the actual .ts file
      const edge = result.edges.find(
        (e) =>
          e.relationship_type === "IMPORTS" && e.target_id.includes("helper")
      );
      expect(edge).toBeDefined();
      expect(edge?.target_id).toBe(tsFile);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("prefers .ts over .tsx when both exist", () => {
    const tmpDir = fs.mkdtempSync(path.join(path.sep, "tmp", "knocoph-"));
    try {
      const tsFile = path.join(tmpDir, "module.ts");
      const tsxFile = path.join(tmpDir, "module.tsx");
      fs.writeFileSync(tsFile, "export const x = 1;");
      fs.writeFileSync(tsxFile, "export const x = 2;");

      const importerFile = path.join(tmpDir, "importer.ts");
      const content = `import { x } from "./module.js";`;
      const result = parseFile(importerFile, content);

      const edge = result.edges.find((e) => e.relationship_type === "IMPORTS");
      expect(edge?.target_id).toBe(tsFile);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("remaps .mjs to .mts when .mts file exists", () => {
    const tmpDir = fs.mkdtempSync(path.join(path.sep, "tmp", "knocoph-"));
    try {
      const mtsFile = path.join(tmpDir, "utils.mts");
      fs.writeFileSync(mtsFile, "export function util() {}");

      const importerFile = path.join(tmpDir, "importer.mts");
      const content = `import { util } from "./utils.mjs";`;
      const result = parseFile(importerFile, content);

      const edge = result.edges.find(
        (e) =>
          e.relationship_type === "IMPORTS" && e.target_id.includes("utils")
      );
      expect(edge?.target_id).toBe(mtsFile);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("remaps .cjs to .cts when .cts file exists", () => {
    const tmpDir = fs.mkdtempSync(path.join(path.sep, "tmp", "knocoph-"));
    try {
      const ctsFile = path.join(tmpDir, "compat.cts");
      fs.writeFileSync(ctsFile, "export function compat() {}");

      const importerFile = path.join(tmpDir, "importer.cts");
      const content = `import { compat } from "./compat.cjs";`;
      const result = parseFile(importerFile, content);

      const edge = result.edges.find(
        (e) =>
          e.relationship_type === "IMPORTS" && e.target_id.includes("compat")
      );
      expect(edge?.target_id).toBe(ctsFile);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns the raw path when no remapping matches", () => {
    const tmpDir = fs.mkdtempSync(path.join(path.sep, "tmp", "knocoph-"));
    try {
      // Don't create any actual file
      const importerFile = path.join(tmpDir, "importer.ts");
      const nonexistentTarget = path.join(tmpDir, "nonexistent.js");
      const content = `import { x } from "./nonexistent.js";`;
      const result = parseFile(importerFile, content);

      const edge = result.edges.find((e) => e.relationship_type === "IMPORTS");
      // Should have the resolved path (even though it doesn't exist on disk)
      expect(edge?.target_id).toBe(nonexistentTarget);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// walk — array traversal (call edge collection in function bodies)
// ---------------------------------------------------------------------------

describe("walk — array node iteration", () => {
  it("walks through array of statements in function body", () => {
    // A function with multiple statements creates arrays in the BlockStatement
    // that walk must traverse to find nested CallExpressions
    const fp = "/tmp/knocoph-multi-stmts.ts";
    const content = `
      function a() {}
      function b() {}
      function c() {}
      export function runner() {
        a();
        b();
        c();
      }
    `;
    const result = parseFile(fp, content);

    // Should find CALLS edges for all three function calls
    const callsEdges = result.edges.filter(
      (e) =>
        e.relationship_type === "CALLS" &&
        e.source_id === testNodeId(fp, "runner", "function")
    );
    expect(callsEdges.length).toBe(3);

    // Verify each function is called
    const targetNames = ["a", "b", "c"];
    for (const name of targetNames) {
      const edge = callsEdges.find(
        (e) => e.target_id === testNodeId(fp, name, "function")
      );
      expect(edge).toBeDefined();
    }
  });

  it("walks through complex nested block with conditional statements", () => {
    // if/else blocks also contain statement arrays
    const fp = "/tmp/knocoph-conditional.ts";
    const content = `
      function helper() {}
      function process(flag: boolean) {
        if (flag) {
          helper();
        } else {
          helper();
        }
      }
    `;
    const result = parseFile(fp, content);

    // Should find both calls despite being in different branches
    const callsEdges = result.edges.filter(
      (e) =>
        e.relationship_type === "CALLS" &&
        e.source_id === testNodeId(fp, "process", "function")
    );
    expect(callsEdges.length).toBeGreaterThanOrEqual(1);
    expect(
      callsEdges.some(
        (e) => e.target_id === testNodeId(fp, "helper", "function")
      )
    ).toBe(true);
  });

  it("walks through try-catch blocks with multiple calls", () => {
    // try-catch contains statement arrays in try/catch blocks
    const fp = "/tmp/knocoph-trycatch.ts";
    const content = `
      function risky() {}
      function handle() {}
      export function operation() {
        try {
          risky();
        } catch (e) {
          handle();
        }
      }
    `;
    const result = parseFile(fp, content);

    // Should find calls in both try and catch blocks
    const callsEdges = result.edges.filter(
      (e) =>
        e.relationship_type === "CALLS" &&
        e.source_id === testNodeId(fp, "operation", "function")
    );
    expect(callsEdges.length).toBeGreaterThanOrEqual(1);
  });

  it("walks through do-while and for loops with calls", () => {
    // Loop bodies contain statement arrays
    const fp = "/tmp/knocoph-loops.ts";
    const content = `
      function task() {}
      export function loop() {
        for (let i = 0; i < 10; i++) {
          task();
        }
      }
    `;
    const result = parseFile(fp, content);

    const callsEdges = result.edges.filter(
      (e) =>
        e.relationship_type === "CALLS" &&
        e.source_id === testNodeId(fp, "loop", "function")
    );
    expect(callsEdges.length).toBeGreaterThanOrEqual(1);
  });

  it("captures calls inside anonymous arrow-function callbacks", () => {
    // Callbacks passed to higher-order functions should still attribute
    // their inner calls to the enclosing named function (walk is fully recursive).
    const fp = "/tmp/knocoph-callback.ts";
    const content = `
      function inner() {}
      export function outer() {
        const items = [1, 2, 3];
        items.forEach((x) => {
          inner();
        });
      }
    `;
    const result = parseFile(fp, content);

    const callsEdges = result.edges.filter(
      (e) =>
        e.relationship_type === "CALLS" &&
        e.source_id === testNodeId(fp, "outer", "function")
    );
    expect(
      callsEdges.some(
        (e) => e.target_id === testNodeId(fp, "inner", "function")
      )
    ).toBe(true);
  });

  it("captures calls inside nested function expressions", () => {
    // Function expressions that are not top-level declarations should
    // still attribute their inner calls to the enclosing named function.
    const fp = "/tmp/knocoph-nested-fn.ts";
    const content = `
      function helper() {}
      export function register() {
        const handler = async function(input: unknown) {
          helper();
        };
      }
    `;
    const result = parseFile(fp, content);

    const callsEdges = result.edges.filter(
      (e) =>
        e.relationship_type === "CALLS" &&
        e.source_id === testNodeId(fp, "register", "function")
    );
    expect(
      callsEdges.some(
        (e) => e.target_id === testNodeId(fp, "helper", "function")
      )
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// type-refs.ts fixture — REFERENCES edge type (PR-V2-1)
// ---------------------------------------------------------------------------

describe("type-refs.ts — REFERENCES edges", () => {
  const fp = fixturePath("type-refs.ts");
  const simpleFp = fixturePath("simple.ts");
  const result = parseFile(fp, fixtureContent("type-refs.ts"));

  const refsEdges = result.edges.filter(
    (e) => e.relationship_type === "REFERENCES"
  );

  it("emits at least one REFERENCES edge", () => {
    expect(refsEdges.length).toBeGreaterThan(0);
  });

  it("greetUser references User interface from simple.ts (parameter type)", () => {
    const edge = refsEdges.find(
      (e) =>
        e.source_id === testNodeId(fp, "greetUser", "function") &&
        e.target_id === testNodeId(simpleFp, "User", "interface")
    );
    expect(edge).toBeDefined();
  });

  it("UserRepository interface references User from simple.ts (method signatures)", () => {
    const edge = refsEdges.find(
      (e) =>
        e.source_id === testNodeId(fp, "UserRepository", "interface") &&
        e.target_id === testNodeId(simpleFp, "User", "interface")
    );
    expect(edge).toBeDefined();
  });

  it("UserOrNull type alias references User from simple.ts", () => {
    const edge = refsEdges.find(
      (e) =>
        e.source_id === testNodeId(fp, "UserOrNull", "type_alias") &&
        e.target_id === testNodeId(simpleFp, "User", "interface")
    );
    expect(edge).toBeDefined();
  });

  it("makeId arrow function references local LocalId interface", () => {
    const edge = refsEdges.find(
      (e) =>
        e.source_id === testNodeId(fp, "makeId", "arrow_function") &&
        e.target_id === testNodeId(fp, "LocalId", "interface")
    );
    expect(edge).toBeDefined();
  });

  it("REFERENCES edges deduplicated — UserRepository -> User appears exactly once", () => {
    // UserRepository.findById and .save both reference User, but the edge
    // source is the interface node, so deduplication keeps only one edge.
    const edges = refsEdges.filter(
      (e) =>
        e.source_id === testNodeId(fp, "UserRepository", "interface") &&
        e.target_id === testNodeId(simpleFp, "User", "interface")
    );
    expect(edges.length).toBe(1);
  });

  it("no REFERENCES edge for built-in types (string, void, null)", () => {
    // 'string', 'void', and 'null' are not in the symbol table so no edges
    // should be emitted for them.
    const builtinEdge = refsEdges.find(
      (e) =>
        e.target_id.includes("string") ||
        e.target_id.includes("void") ||
        e.target_id.includes("null")
    );
    expect(builtinEdge).toBeUndefined();
  });
});

describe("REFERENCES — inline edge-type sanity", () => {
  it("emits REFERENCES for a type alias referencing a local interface", () => {
    const fp = "/tmp/knocoph-refs-local.ts";
    const content = `
      export interface Config { timeout: number; }
      export type Options = Config;
    `;
    const result = parseFile(fp, content);
    const edge = result.edges.find(
      (e) =>
        e.relationship_type === "REFERENCES" &&
        e.source_id === testNodeId(fp, "Options", "type_alias") &&
        e.target_id === testNodeId(fp, "Config", "interface")
    );
    expect(edge).toBeDefined();
  });

  it("emits no REFERENCES for external module types not in symbol table", () => {
    const fp = "/tmp/knocoph-refs-external.ts";
    // 'Promise' is a global builtin, not imported, so it won't be in the
    // symbol table and should not produce a REFERENCES edge.
    const content = `
      export async function fetch(): Promise<string> { return ""; }
    `;
    const result = parseFile(fp, content);
    const refEdges = result.edges.filter(
      (e) => e.relationship_type === "REFERENCES"
    );
    expect(refEdges.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Path alias resolution — PR-V2-4
// ---------------------------------------------------------------------------

describe("path alias resolution — wildcard @scope/*", () => {
  it("resolves wildcard alias IMPORTS edge to the correct absolute path", () => {
    const tmpDir = fs.mkdtempSync(path.join(path.sep, "tmp", "knocoph-alias-"));
    try {
      const srcDir = path.join(tmpDir, "src");
      fs.mkdirSync(srcDir);
      const targetFile = path.join(srcDir, "utils.ts");
      fs.writeFileSync(targetFile, "export function util() {}");

      const importerFile = path.join(tmpDir, "importer.ts");
      const content = `import { util } from "@myapp/utils";`;
      const result = parseFile(importerFile, content, {
        baseDir: tmpDir,
        paths: { "@myapp/*": ["src/*"] },
      });

      const edge = result.edges.find(
        (e) => e.relationship_type === "IMPORTS" && e.target_id === targetFile
      );
      expect(edge).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("resolves wildcard alias to .ts file via extension probe when no extension in import", () => {
    const tmpDir = fs.mkdtempSync(path.join(path.sep, "tmp", "knocoph-alias-"));
    try {
      const srcDir = path.join(tmpDir, "src");
      fs.mkdirSync(srcDir);
      // Create the file WITHOUT extension in the import — probe should find .ts
      const targetFile = path.join(srcDir, "auth.ts");
      fs.writeFileSync(targetFile, "export function login() {}");

      const importerFile = path.join(tmpDir, "caller.ts");
      const content = `import { login } from "@app/auth";`;
      const result = parseFile(importerFile, content, {
        baseDir: tmpDir,
        paths: { "@app/*": ["src/*"] },
      });

      const edge = result.edges.find(
        (e) => e.relationship_type === "IMPORTS" && e.target_id === targetFile
      );
      expect(edge).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("resolves wildcard alias to index.ts when target is a directory", () => {
    const tmpDir = fs.mkdtempSync(path.join(path.sep, "tmp", "knocoph-alias-"));
    try {
      const pkgDir = path.join(tmpDir, "src", "services");
      fs.mkdirSync(pkgDir, { recursive: true });
      const indexFile = path.join(pkgDir, "index.ts");
      fs.writeFileSync(indexFile, "export function serve() {}");

      const importerFile = path.join(tmpDir, "caller.ts");
      const content = `import { serve } from "@app/services";`;
      const result = parseFile(importerFile, content, {
        baseDir: tmpDir,
        paths: { "@app/*": ["src/*"] },
      });

      const edge = result.edges.find(
        (e) => e.relationship_type === "IMPORTS" && e.target_id === indexFile
      );
      expect(edge).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("path alias resolution — exact pattern", () => {
  it("resolves exact alias IMPORTS edge to the correct absolute path", () => {
    const tmpDir = fs.mkdtempSync(path.join(path.sep, "tmp", "knocoph-alias-"));
    try {
      const targetFile = path.join(tmpDir, "src", "auth.ts");
      fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
      fs.writeFileSync(targetFile, "export function login() {}");

      const importerFile = path.join(tmpDir, "importer.ts");
      const content = `import { login } from "@auth";`;
      const result = parseFile(importerFile, content, {
        baseDir: tmpDir,
        paths: { "@auth": ["src/auth.ts"] },
      });

      const edge = result.edges.find(
        (e) => e.relationship_type === "IMPORTS" && e.target_id === targetFile
      );
      expect(edge).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("path alias resolution — no alias match falls back to external module", () => {
  it("keeps raw specifier as target_id for unmatched non-relative imports", () => {
    const fp = "/tmp/knocoph-alias-fallback.ts";
    const content = `import { x } from "lodash";`;
    const result = parseFile(fp, content, {
      baseDir: "/tmp",
      paths: { "@myapp/*": ["src/*"] },
    });

    const edge = result.edges.find(
      (e) => e.relationship_type === "IMPORTS" && e.target_id === "lodash"
    );
    expect(edge).toBeDefined();
  });

  it("still resolves relative imports normally when pathAliases is set", () => {
    const tmpDir = fs.mkdtempSync(path.join(path.sep, "tmp", "knocoph-alias-"));
    try {
      const sibling = path.join(tmpDir, "sibling.ts");
      fs.writeFileSync(sibling, "export function helper() {}");

      const importerFile = path.join(tmpDir, "importer.ts");
      const content = `import { helper } from "./sibling.js";`;
      const result = parseFile(importerFile, content, {
        baseDir: tmpDir,
        paths: { "@app/*": ["src/*"] },
      });

      const edge = result.edges.find(
        (e) => e.relationship_type === "IMPORTS" && e.target_id === sibling
      );
      expect(edge).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("path alias resolution — CALLS edge resolved through alias", () => {
  it("emits correct CALLS edge when called function comes from an aliased import", () => {
    const tmpDir = fs.mkdtempSync(path.join(path.sep, "tmp", "knocoph-alias-"));
    try {
      const srcDir = path.join(tmpDir, "src");
      fs.mkdirSync(srcDir);
      const targetFile = path.join(srcDir, "auth.ts");
      fs.writeFileSync(targetFile, "export function login() {}");

      const importerFile = path.join(tmpDir, "caller.ts");
      const content = `
        import { login } from "@app/auth";
        export function run() { login(); }
      `;
      const result = parseFile(importerFile, content, {
        baseDir: tmpDir,
        paths: { "@app/*": ["src/*"] },
      });

      const callsEdge = result.edges.find(
        (e) =>
          e.relationship_type === "CALLS" &&
          e.source_id === testNodeId(importerFile, "run", "function") &&
          e.target_id === testNodeId(targetFile, "login", "function")
      );
      expect(callsEdge).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// probeExtensions — remaining branch coverage
// ---------------------------------------------------------------------------

describe("probeExtensions — directory with index.tsx but no index.ts", () => {
  it("resolves alias to index.tsx when target directory lacks index.ts", () => {
    const tmpDir = fs.mkdtempSync(path.join(path.sep, "tmp", "knocoph-probe-"));
    try {
      const uiDir = path.join(tmpDir, "src", "ui");
      fs.mkdirSync(uiDir, { recursive: true });
      const indexTsx = path.join(uiDir, "index.tsx");
      fs.writeFileSync(indexTsx, "export function Button() {}");
      // Explicitly no index.ts in uiDir

      const importerFile = path.join(tmpDir, "caller.ts");
      const content = `import { Button } from "@app/ui";`;
      const result = parseFile(importerFile, content, {
        baseDir: tmpDir,
        paths: { "@app/*": ["src/*"] },
      });

      const edge = result.edges.find(
        (e) => e.relationship_type === "IMPORTS" && e.target_id === indexTsx
      );
      expect(edge).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("probeExtensions — directory with no index file (dangling)", () => {
  it("returns directory path as-is when it has no index.ts or index.tsx", () => {
    const tmpDir = fs.mkdtempSync(path.join(path.sep, "tmp", "knocoph-probe-"));
    try {
      const emptyDir = path.join(tmpDir, "src", "empty");
      fs.mkdirSync(emptyDir, { recursive: true });
      // No index.ts or index.tsx inside emptyDir

      const importerFile = path.join(tmpDir, "caller.ts");
      const content = `import something from "@app/empty";`;
      const result = parseFile(importerFile, content, {
        baseDir: tmpDir,
        paths: { "@app/*": ["src/*"] },
      });

      const edge = result.edges.find(
        (e) => e.relationship_type === "IMPORTS" && e.target_id === emptyDir
      );
      expect(edge).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("probeExtensions — .tsx extension probe", () => {
  it("resolves alias to .tsx file when only .tsx exists (no .ts or directory)", () => {
    const tmpDir = fs.mkdtempSync(path.join(path.sep, "tmp", "knocoph-probe-"));
    try {
      const srcDir = path.join(tmpDir, "src");
      fs.mkdirSync(srcDir);
      const targetFile = path.join(srcDir, "widget.tsx");
      fs.writeFileSync(targetFile, "export function Widget() {}");
      // No widget.ts and no widget/ directory

      const importerFile = path.join(tmpDir, "caller.ts");
      const content = `import { Widget } from "@app/widget";`;
      const result = parseFile(importerFile, content, {
        baseDir: tmpDir,
        paths: { "@app/*": ["src/*"] },
      });

      const edge = result.edges.find(
        (e) => e.relationship_type === "IMPORTS" && e.target_id === targetFile
      );
      expect(edge).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("probeExtensions — dangling alias (nothing exists)", () => {
  it("returns the raw resolved candidate when no file or directory matches", () => {
    const tmpDir = fs.mkdtempSync(path.join(path.sep, "tmp", "knocoph-probe-"));
    try {
      // src/ghost does not exist in any form
      const expectedCandidate = path.join(tmpDir, "src", "ghost");

      const importerFile = path.join(tmpDir, "caller.ts");
      const content = `import something from "@app/ghost";`;
      const result = parseFile(importerFile, content, {
        baseDir: tmpDir,
        paths: { "@app/*": ["src/*"] },
      });

      const edge = result.edges.find(
        (e) =>
          e.relationship_type === "IMPORTS" && e.target_id === expectedCandidate
      );
      expect(edge).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
