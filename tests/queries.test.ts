import { beforeAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";

import { SCHEMA_SQL } from "../src/db.js";
import { insertEdge, insertFile, insertNode } from "../src/graph.js";
import {
  codebaseOverview,
  explainImpact,
  findSymbol,
  getNeighbors,
  queryArchitecture,
  resolveNode,
  whyIsThisUsed,
} from "../src/queries.js";
import type { ParsedEdge, ParsedNode } from "../src/types.js";

// Helper: fresh in-memory DB with full schema applied.
// foreign_keys ON is required so ON DELETE CASCADE works.
function makeDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  return db;
}

// ---------------------------------------------------------------------------
// findSymbol
// ---------------------------------------------------------------------------

describe("findSymbol", () => {
  let db: Database.Database;

  const FILE = "/test/find.ts";

  const nodeAlpha: ParsedNode = {
    id: "find-alpha",
    name: "alpha",
    kind: "function",
    file_path: FILE,
    start_line: 1,
    end_line: 3,
    exported: 1,
  };
  const nodeBetaFn: ParsedNode = {
    id: "find-beta-fn",
    name: "beta",
    kind: "function",
    file_path: FILE,
    start_line: 5,
    end_line: 7,
    exported: 0,
  };
  const nodeBetaClass: ParsedNode = {
    id: "find-beta-class",
    name: "beta",
    kind: "class",
    file_path: FILE,
    start_line: 9,
    end_line: 15,
    exported: 1,
  };
  const nodeAlphabetical: ParsedNode = {
    id: "find-alphabetical",
    name: "alphabetical",
    kind: "variable",
    file_path: FILE,
    start_line: 17,
    end_line: 17,
    exported: 0,
  };

  beforeAll(() => {
    db = makeDb();
    insertFile(db, FILE, "hash-find");
    insertNode(db, nodeAlpha);
    insertNode(db, nodeBetaFn);
    insertNode(db, nodeBetaClass);
    insertNode(db, nodeAlphabetical);
  });

  it("exact match returns the correct node", () => {
    const results = findSymbol(db, "alpha");
    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe("find-alpha");
    expect(results[0]?.name).toBe("alpha");
  });

  it("exact match with no result returns empty array", () => {
    const results = findSymbol(db, "nonexistent");
    expect(results).toHaveLength(0);
  });

  it("prefix match returns all nodes whose name starts with the prefix", () => {
    // "alpha" prefix matches "alpha" and "alphabetical"
    const results = findSymbol(db, "alpha", undefined, false);
    expect(results).toHaveLength(2);
    const names = results.map((n) => n.name);
    expect(names).toContain("alpha");
    expect(names).toContain("alphabetical");
  });

  it("kind filter returns only nodes of the specified kind", () => {
    // "beta" matches both function and class nodes; filter to class only
    const results = findSymbol(db, "beta", "class");
    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe("find-beta-class");
    expect(results[0]?.kind).toBe("class");
  });

  it("kind filter with no matching kind returns empty array", () => {
    const results = findSymbol(db, "alpha", "interface");
    expect(results).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// resolveNode
// ---------------------------------------------------------------------------

describe("resolveNode", () => {
  let db: Database.Database;

  const FILE = "/test/resolve.ts";

  const nodeUnique: ParsedNode = {
    id: "resolve-unique",
    name: "uniqueSymbol",
    kind: "function",
    file_path: FILE,
    start_line: 1,
    end_line: 3,
    exported: 1,
  };
  const nodeAmbigFn: ParsedNode = {
    id: "resolve-ambig-fn",
    name: "ambiguous",
    kind: "function",
    file_path: FILE,
    start_line: 5,
    end_line: 7,
    exported: 0,
  };
  const nodeAmbigClass: ParsedNode = {
    id: "resolve-ambig-class",
    name: "ambiguous",
    kind: "class",
    file_path: FILE,
    start_line: 9,
    end_line: 15,
    exported: 1,
  };

  beforeAll(() => {
    db = makeDb();
    insertFile(db, FILE, "hash-resolve");
    insertNode(db, nodeUnique);
    insertNode(db, nodeAmbigFn);
    insertNode(db, nodeAmbigClass);
  });

  it("resolves by node_id when provided", () => {
    const node = resolveNode(db, "resolve-unique");
    expect(node.id).toBe("resolve-unique");
    expect(node.name).toBe("uniqueSymbol");
  });

  it("resolves by name when node_id is not provided", () => {
    const node = resolveNode(db, undefined, "uniqueSymbol");
    expect(node.id).toBe("resolve-unique");
  });

  it("throws when node_id does not exist", () => {
    expect(() => resolveNode(db, "nonexistent-id")).toThrow("Node not found");
  });

  it("throws when neither node_id nor name is provided", () => {
    expect(() => resolveNode(db)).toThrow(
      "Either node_id or name must be provided."
    );
  });

  it("throws when name matches no symbols", () => {
    expect(() => resolveNode(db, undefined, "noSuchSymbol")).toThrow(
      "No symbol found"
    );
  });

  it("throws when name is ambiguous (multiple matches)", () => {
    expect(() => resolveNode(db, undefined, "ambiguous")).toThrow("Ambiguous");
  });

  it("kind disambiguates when name has multiple matches", () => {
    const node = resolveNode(db, undefined, "ambiguous", "class");
    expect(node.id).toBe("resolve-ambig-class");
    expect(node.kind).toBe("class");
  });

  it("node_id takes precedence over name", () => {
    // Provide both: node_id wins
    const node = resolveNode(db, "resolve-unique", "ambiguous");
    expect(node.id).toBe("resolve-unique");
  });
});

// ---------------------------------------------------------------------------
// getNeighbors
// ---------------------------------------------------------------------------

describe("getNeighbors", () => {
  let db: Database.Database;

  const FILE = "/test/neighbors.ts";

  // A --CALLS--> B
  // C --IMPORTS--> A  (so A has an incoming IMPORTS edge from C)
  // A --CALLS--> dangling (target_id not in nodes table)

  const nodeA: ParsedNode = {
    id: "nbr-a",
    name: "A",
    kind: "function",
    file_path: FILE,
    start_line: 1,
    end_line: 5,
    exported: 0,
  };
  const nodeB: ParsedNode = {
    id: "nbr-b",
    name: "B",
    kind: "function",
    file_path: FILE,
    start_line: 7,
    end_line: 10,
    exported: 0,
  };
  const nodeC: ParsedNode = {
    id: "nbr-c",
    name: "C",
    kind: "function",
    file_path: FILE,
    start_line: 12,
    end_line: 15,
    exported: 0,
  };

  const edgeAtoB: ParsedEdge = {
    source_id: "nbr-a",
    target_id: "nbr-b",
    relationship_type: "CALLS",
  };
  const edgeCtoA: ParsedEdge = {
    source_id: "nbr-c",
    target_id: "nbr-a",
    relationship_type: "IMPORTS",
  };
  const edgeAtoDangling: ParsedEdge = {
    source_id: "nbr-a",
    target_id: "nbr-dangling",
    relationship_type: "CALLS",
  };

  beforeAll(() => {
    db = makeDb();
    insertFile(db, FILE, "hash-nbr");
    insertNode(db, nodeA);
    insertNode(db, nodeB);
    insertNode(db, nodeC);
    // Insert edges — including one to a non-existent node (dangling)
    insertEdge(db, edgeAtoB);
    insertEdge(db, edgeCtoA);
    insertEdge(db, edgeAtoDangling);
  });

  it("outgoing returns edges where source_id equals the given node", () => {
    const result = getNeighbors(db, "nbr-a", "outgoing");
    // A has two outgoing edges: A->B and A->dangling
    expect(result.edges).toHaveLength(2);
    for (const edge of result.edges) {
      expect(edge.source_id).toBe("nbr-a");
    }
  });

  it("incoming returns edges where target_id equals the given node", () => {
    const result = getNeighbors(db, "nbr-a", "incoming");
    // Only C->A is incoming
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0]?.source_id).toBe("nbr-c");
    expect(result.edges[0]?.target_id).toBe("nbr-a");
  });

  it("both returns the union of outgoing and incoming edges", () => {
    const result = getNeighbors(db, "nbr-a", "both");
    // outgoing: A->B, A->dangling (2); incoming: C->A (1); total 3
    expect(result.edges).toHaveLength(3);
  });

  it("relationship type filter returns only edges of the specified types", () => {
    const result = getNeighbors(db, "nbr-a", "outgoing", ["IMPORTS"]);
    // A has no outgoing IMPORTS edges
    expect(result.edges).toHaveLength(0);

    const result2 = getNeighbors(db, "nbr-a", "outgoing", ["CALLS"]);
    expect(result2.edges).toHaveLength(2);
    for (const edge of result2.edges) {
      expect(edge.relationship_type).toBe("CALLS");
    }
  });

  it("dangling target appears in edges array but not in nodes array", () => {
    const result = getNeighbors(db, "nbr-a", "outgoing", ["CALLS"]);
    const edgeTargets = result.edges.map((e) => e.target_id);
    const nodeIds = result.nodes.map((n) => n.id);

    // The dangling target_id is in edges
    expect(edgeTargets).toContain("nbr-dangling");
    // But it is not a node in the DB — so absent from nodes array
    expect(nodeIds).not.toContain("nbr-dangling");
  });
});

// ---------------------------------------------------------------------------
// explainImpact
// ---------------------------------------------------------------------------

describe("explainImpact", () => {
  let db: Database.Database;

  // Graph layout (edge direction represents "depends on"):
  //   B depends on A   →  edge(source=B, target=A)
  //   C depends on B   →  edge(source=C, target=B)
  //   D depends on C   →  edge(source=D, target=C)
  //
  // Cycle graph:
  //   B depends on A   →  edge(source=B, target=A)
  //   C depends on B   →  edge(source=C, target=B)
  //   A depends on C   →  edge(source=A, target=C)
  //
  // Diamond graph:
  //   B depends on A   →  edge(source=B, target=A)
  //   C depends on A   →  edge(source=C, target=A)
  //   D depends on B   →  edge(source=D, target=B)
  //   D depends on C   →  edge(source=D, target=C)

  const FILE = "/test/impact.ts";

  const makeNode = (id: string, name: string): ParsedNode => ({
    id,
    name,
    kind: "function",
    file_path: FILE,
    start_line: 1,
    end_line: 2,
    exported: 0,
  });

  // Linear chain nodes
  const nA = makeNode("imp-a", "A");
  const nB = makeNode("imp-b", "B");
  const nC = makeNode("imp-c", "C");
  const nD = makeNode("imp-d", "D");

  // Cycle nodes (reuse nA, nB, nC — different DB)
  // Diamond nodes (reuse nA, nB, nC, nD — different DB)
  // We use separate databases per sub-scenario below.

  it("linear chain: explainImpact(A, 5) returns B(1), C(2), D(3)", () => {
    const chainDb = makeDb();
    insertFile(chainDb, FILE, "hash-chain");
    insertNode(chainDb, nA);
    insertNode(chainDb, nB);
    insertNode(chainDb, nC);
    insertNode(chainDb, nD);
    insertEdge(chainDb, {
      source_id: "imp-b",
      target_id: "imp-a",
      relationship_type: "CALLS",
    });
    insertEdge(chainDb, {
      source_id: "imp-c",
      target_id: "imp-b",
      relationship_type: "CALLS",
    });
    insertEdge(chainDb, {
      source_id: "imp-d",
      target_id: "imp-c",
      relationship_type: "CALLS",
    });

    const result = explainImpact(chainDb, "imp-a", 5);
    const map = new Map(result.affected_nodes.map((r) => [r.id, r.depth]));

    expect(map.get("imp-b")).toBe(1);
    expect(map.get("imp-c")).toBe(2);
    expect(map.get("imp-d")).toBe(3);
    // Root node (A) must not appear
    expect(map.has("imp-a")).toBe(false);
  });

  it("depth limit: explainImpact(A, 2) returns only B and C — D must not be present", () => {
    const chainDb = makeDb();
    insertFile(chainDb, FILE, "hash-depth");
    insertNode(chainDb, nA);
    insertNode(chainDb, nB);
    insertNode(chainDb, nC);
    insertNode(chainDb, nD);
    insertEdge(chainDb, {
      source_id: "imp-b",
      target_id: "imp-a",
      relationship_type: "CALLS",
    });
    insertEdge(chainDb, {
      source_id: "imp-c",
      target_id: "imp-b",
      relationship_type: "CALLS",
    });
    insertEdge(chainDb, {
      source_id: "imp-d",
      target_id: "imp-c",
      relationship_type: "CALLS",
    });

    const result = explainImpact(chainDb, "imp-a", 2);
    const ids = result.affected_nodes.map((r) => r.id);

    expect(ids).toContain("imp-b");
    expect(ids).toContain("imp-c");
    expect(ids).not.toContain("imp-d");
    expect(ids).not.toContain("imp-a");
  });

  it("cycle: completes in under 100ms and returns at most 2 results (B and C)", () => {
    const cycleDb = makeDb();
    insertFile(cycleDb, FILE, "hash-cycle");
    insertNode(cycleDb, nA);
    insertNode(cycleDb, nB);
    insertNode(cycleDb, nC);
    // A->B, B->C, C->A (circular dependency chain)
    insertEdge(cycleDb, {
      source_id: "imp-b",
      target_id: "imp-a",
      relationship_type: "CALLS",
    });
    insertEdge(cycleDb, {
      source_id: "imp-c",
      target_id: "imp-b",
      relationship_type: "CALLS",
    });
    insertEdge(cycleDb, {
      source_id: "imp-a",
      target_id: "imp-c",
      relationship_type: "CALLS",
    });

    const start = Date.now();
    const result = explainImpact(cycleDb, "imp-a", 10);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(100);
    // Root A must not appear; at most B and C
    const ids = result.affected_nodes.map((r) => r.id);
    expect(ids).not.toContain("imp-a");
    expect(result.affected_nodes.length).toBeLessThanOrEqual(2);
    expect(ids).toContain("imp-b");
    expect(ids).toContain("imp-c");
  });

  it("diamond: D appears exactly once", () => {
    const diamondDb = makeDb();
    insertFile(diamondDb, FILE, "hash-diamond");
    insertNode(diamondDb, nA);
    insertNode(diamondDb, nB);
    insertNode(diamondDb, nC);
    insertNode(diamondDb, nD);
    // B and C both depend on A; D depends on both B and C
    insertEdge(diamondDb, {
      source_id: "imp-b",
      target_id: "imp-a",
      relationship_type: "CALLS",
    });
    insertEdge(diamondDb, {
      source_id: "imp-c",
      target_id: "imp-a",
      relationship_type: "CALLS",
    });
    insertEdge(diamondDb, {
      source_id: "imp-d",
      target_id: "imp-b",
      relationship_type: "CALLS",
    });
    insertEdge(diamondDb, {
      source_id: "imp-d",
      target_id: "imp-c",
      relationship_type: "CALLS",
    });

    const result = explainImpact(diamondDb, "imp-a", 5);
    const dResults = result.affected_nodes.filter((r) => r.id === "imp-d");

    // D must appear exactly once even though it is reachable via two paths
    expect(dResults).toHaveLength(1);
  });

  it("returns empty affected_nodes when no nodes depend on the given node", () => {
    db = makeDb();
    insertFile(db, FILE, "hash-isolated");
    insertNode(db, nA);

    const result = explainImpact(db, "imp-a", 5);
    expect(result.affected_nodes).toHaveLength(0);
    expect(result.paths).toHaveLength(0);
  });

  it("include_paths=true returns both affected_nodes and paths", () => {
    const chainDb = makeDb();
    insertFile(chainDb, FILE, "hash-paths");
    insertNode(chainDb, nA);
    insertNode(chainDb, nB);
    insertNode(chainDb, nC);
    insertEdge(chainDb, {
      source_id: "imp-b",
      target_id: "imp-a",
      relationship_type: "CALLS",
    });
    insertEdge(chainDb, {
      source_id: "imp-c",
      target_id: "imp-b",
      relationship_type: "CALLS",
    });

    const result = explainImpact(chainDb, "imp-a", 5, true);
    expect(result.affected_nodes.length).toBeGreaterThan(0);
    expect(result.paths.length).toBeGreaterThan(0);
    // paths should contain hop-level info
    expect(result.paths[0]).toHaveProperty("from_name");
    expect(result.paths[0]).toHaveProperty("to_name");
    expect(result.paths[0]).toHaveProperty("relationship_type");
  });

  it("include_paths=false returns empty paths array", () => {
    const chainDb = makeDb();
    insertFile(chainDb, FILE, "hash-nopaths");
    insertNode(chainDb, nA);
    insertNode(chainDb, nB);
    insertEdge(chainDb, {
      source_id: "imp-b",
      target_id: "imp-a",
      relationship_type: "CALLS",
    });

    const result = explainImpact(chainDb, "imp-a", 5, false);
    expect(result.affected_nodes).toHaveLength(1);
    expect(result.paths).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// whyIsThisUsed
// ---------------------------------------------------------------------------

describe("whyIsThisUsed", () => {
  let db: Database.Database;

  const FILE = "/test/why.ts";

  const nodeP: ParsedNode = {
    id: "why-p",
    name: "P",
    kind: "function",
    file_path: FILE,
    start_line: 1,
    end_line: 4,
    exported: 1,
  };
  const nodeQ: ParsedNode = {
    id: "why-q",
    name: "Q",
    kind: "function",
    file_path: FILE,
    start_line: 6,
    end_line: 9,
    exported: 0,
  };
  const nodeR: ParsedNode = {
    id: "why-r",
    name: "R",
    kind: "function",
    file_path: FILE,
    start_line: 11,
    end_line: 14,
    exported: 0,
  };

  beforeAll(() => {
    db = makeDb();
    insertFile(db, FILE, "hash-why");
    insertNode(db, nodeP);
    insertNode(db, nodeQ);
    insertNode(db, nodeR);
    // Q calls P, R calls P
    insertEdge(db, {
      source_id: "why-q",
      target_id: "why-p",
      relationship_type: "CALLS",
    });
    insertEdge(db, {
      source_id: "why-r",
      target_id: "why-p",
      relationship_type: "CALLS",
    });
  });

  it("single caller: whyIsThisUsed(P) with only Q returns one path row", () => {
    // Use a fresh DB with only Q calling P (not R)
    const singleDb = makeDb();
    insertFile(singleDb, FILE, "hash-single");
    insertNode(singleDb, nodeP);
    insertNode(singleDb, nodeQ);
    insertEdge(singleDb, {
      source_id: "why-q",
      target_id: "why-p",
      relationship_type: "CALLS",
    });

    const result = whyIsThisUsed(singleDb, "why-p", 3);

    expect(result).toHaveLength(1);
    const row = result[0];
    expect(row).toBeDefined();
    expect(row!.from_name).toBe("Q");
    expect(row!.to_name).toBe("P");
    expect(row!.depth).toBe(1);
    expect(row!.relationship_type).toBe("CALLS");
  });

  it("two callers: whyIsThisUsed(P) returns two path rows", () => {
    const result = whyIsThisUsed(db, "why-p", 3);

    expect(result).toHaveLength(2);
    const fromNames = result.map((r) => r.from_name);
    expect(fromNames).toContain("Q");
    expect(fromNames).toContain("R");

    for (const row of result) {
      expect(row.to_name).toBe("P");
      expect(row.depth).toBe(1);
    }
  });

  it("returns empty array when no node uses the given node", () => {
    // Q has no callers
    const result = whyIsThisUsed(db, "why-q", 3);
    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// queryArchitecture
// ---------------------------------------------------------------------------

describe("queryArchitecture", () => {
  let db: Database.Database;

  const FILE_X = "/test/arch-x.ts";
  const FILE_Y = "/test/arch-y.ts";

  // File X defines X1 and X2; file Y defines Y1.
  // Internal edge: X1 --CONTAINS--> X2 (both in FILE_X)
  // Cross-file edge: X1 --CALLS--> Y1 (X1 in FILE_X, Y1 in FILE_Y)

  const nodeX1: ParsedNode = {
    id: "arch-x1",
    name: "xone",
    kind: "class",
    file_path: FILE_X,
    start_line: 1,
    end_line: 10,
    exported: 1,
  };
  const nodeX2: ParsedNode = {
    id: "arch-x2",
    name: "xtwo",
    kind: "method",
    file_path: FILE_X,
    start_line: 3,
    end_line: 5,
    exported: 0,
  };
  const nodeY1: ParsedNode = {
    id: "arch-y1",
    name: "yone",
    kind: "function",
    file_path: FILE_Y,
    start_line: 1,
    end_line: 4,
    exported: 1,
  };

  const internalEdge: ParsedEdge = {
    source_id: "arch-x1",
    target_id: "arch-x2",
    relationship_type: "CONTAINS",
  };
  const crossFileEdge: ParsedEdge = {
    source_id: "arch-x1",
    target_id: "arch-y1",
    relationship_type: "CALLS",
  };

  beforeAll(() => {
    db = makeDb();
    insertFile(db, FILE_X, "hash-arch-x");
    insertFile(db, FILE_Y, "hash-arch-y");
    insertNode(db, nodeX1);
    insertNode(db, nodeX2);
    insertNode(db, nodeY1);
    insertEdge(db, internalEdge);
    insertEdge(db, crossFileEdge);
  });

  it("defined_symbols lists all nodes in the file", () => {
    const result = queryArchitecture(db, FILE_X, false);
    const ids = result.defined_symbols.map((n) => n.id);
    expect(ids).toContain("arch-x1");
    expect(ids).toContain("arch-x2");
    expect(ids).not.toContain("arch-y1");
  });

  it("includeInternalEdges=false returns only cross-file edges", () => {
    const result = queryArchitecture(db, FILE_X, false);

    // Only the cross-file edge (X1 -> Y1) should be returned
    expect(result.cross_file_edges).toHaveLength(1);
    expect(result.cross_file_edges[0]?.source_id).toBe("arch-x1");
    expect(result.cross_file_edges[0]?.target_id).toBe("arch-y1");
  });

  it("includeInternalEdges=true returns both internal and cross-file edges", () => {
    const result = queryArchitecture(db, FILE_X, true);

    expect(result.cross_file_edges).toHaveLength(2);
    const targets = result.cross_file_edges.map((e) => e.target_id);
    expect(targets).toContain("arch-x2");
    expect(targets).toContain("arch-y1");
  });

  it("returns empty results for a file with no nodes or edges", () => {
    const FILE_Z = "/test/arch-z.ts";
    insertFile(db, FILE_Z, "hash-arch-z");
    // No nodes or edges inserted for FILE_Z

    const result = queryArchitecture(db, FILE_Z, false);
    expect(result.defined_symbols).toHaveLength(0);
    expect(result.cross_file_edges).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// codebaseOverview
// ---------------------------------------------------------------------------

describe("codebaseOverview", () => {
  it("returns all-zero counts and empty arrays on an empty DB", () => {
    const db = makeDb();
    const result = codebaseOverview(db);
    expect(result.file_count).toBe(0);
    expect(result.node_count).toBe(0);
    expect(result.edge_count).toBe(0);
    expect(result.node_kinds).toHaveLength(0);
    expect(result.edge_types).toHaveLength(0);
    expect(result.top_called).toHaveLength(0);
    expect(result.top_imported).toHaveLength(0);
    expect(result.entry_points).toHaveLength(0);
  });

  it("returns correct counts and top_called for a seeded DB", () => {
    const db = makeDb();

    const FILE_A = "/overview/a.ts";
    const FILE_B = "/overview/b.ts";
    insertFile(db, FILE_A, "hash-ov-a");
    insertFile(db, FILE_B, "hash-ov-b");

    // 3 nodes in FILE_A
    const fnFoo: ParsedNode = {
      id: "ov-foo",
      name: "foo",
      kind: "function",
      file_path: FILE_A,
      start_line: 1,
      end_line: 3,
      exported: 1,
    };
    const fnBar: ParsedNode = {
      id: "ov-bar",
      name: "bar",
      kind: "function",
      file_path: FILE_A,
      start_line: 5,
      end_line: 7,
      exported: 0,
    };
    // 2 nodes in FILE_B
    const fnBaz: ParsedNode = {
      id: "ov-baz",
      name: "baz",
      kind: "function",
      file_path: FILE_B,
      start_line: 1,
      end_line: 2,
      exported: 1,
    };
    const clsMyClass: ParsedNode = {
      id: "ov-myclass",
      name: "MyClass",
      kind: "class",
      file_path: FILE_B,
      start_line: 4,
      end_line: 10,
      exported: 1,
    };
    insertNode(db, fnFoo);
    insertNode(db, fnBar);
    insertNode(db, fnBaz);
    insertNode(db, clsMyClass);

    // 3 CALLS edges: foo <- bar (bar calls foo), foo <- baz (baz calls foo), myclass <- bar
    const edgeBarCallsFoo: ParsedEdge = {
      source_id: "ov-bar",
      target_id: "ov-foo",
      relationship_type: "CALLS",
    };
    const edgeBazCallsFoo: ParsedEdge = {
      source_id: "ov-baz",
      target_id: "ov-foo",
      relationship_type: "CALLS",
    };
    const edgeBarCallsMyClass: ParsedEdge = {
      source_id: "ov-bar",
      target_id: "ov-myclass",
      relationship_type: "CALLS",
    };
    insertEdge(db, edgeBarCallsFoo);
    insertEdge(db, edgeBazCallsFoo);
    insertEdge(db, edgeBarCallsMyClass);

    const result = codebaseOverview(db);

    // Counts
    expect(result.file_count).toBe(2);
    expect(result.node_count).toBe(4);
    expect(result.edge_count).toBe(3);

    // node_kinds: function(3) and class(1)
    expect(result.node_kinds).toHaveLength(2);
    expect(result.node_kinds[0]).toMatchObject({ kind: "function", count: 3 });
    expect(result.node_kinds[1]).toMatchObject({ kind: "class", count: 1 });

    // edge_types: CALLS(3)
    expect(result.edge_types).toHaveLength(1);
    expect(result.edge_types[0]).toMatchObject({
      relationship_type: "CALLS",
      count: 3,
    });

    // top_called: foo has 2 incoming CALLS, myclass has 1
    expect(result.top_called).toHaveLength(2);
    expect(result.top_called[0]).toMatchObject({
      id: "ov-foo",
      name: "foo",
      caller_count: 2,
    });
    expect(result.top_called[1]).toMatchObject({
      id: "ov-myclass",
      name: "MyClass",
      caller_count: 1,
    });

    // entry_points: exported nodes with no incoming CALLS
    // foo and myclass both receive CALLS, so they are NOT entry points.
    // baz is exported and has no incoming CALLS -> entry point.
    // bar is not exported -> not an entry point.
    const epIds = result.entry_points.map((n) => n.id);
    expect(epIds).toContain("ov-baz");
    expect(epIds).not.toContain("ov-foo");
    expect(epIds).not.toContain("ov-bar");
    expect(epIds).not.toContain("ov-myclass");
  });

  it("caps entry_points at 20 rows", () => {
    const db = makeDb();
    const FILE_EP = "/overview/ep.ts";
    insertFile(db, FILE_EP, "hash-ov-ep");

    // Seed 25 exported nodes with no callers
    for (let i = 0; i < 25; i++) {
      const node: ParsedNode = {
        id: `ep-node-${i}`,
        name: `epFn${i}`,
        kind: "function",
        file_path: FILE_EP,
        start_line: i * 2 + 1,
        end_line: i * 2 + 2,
        exported: 1,
      };
      insertNode(db, node);
    }

    const result = codebaseOverview(db);
    expect(result.entry_points).toHaveLength(20);
  });
});
