import type Database from "better-sqlite3";

import type { EdgeType, NodeKind, ParsedEdge, ParsedNode } from "./types.js";

// resolveNode — shared helper for name-based resolution.
// Accepts either node_id or name (+optional kind). Returns exactly one node.
// Throws if no match or ambiguous (multiple matches without kind filter).
export function resolveNode(
  db: Database.Database,
  nodeId?: string,
  name?: string,
  kind?: NodeKind
): ParsedNode {
  if (nodeId) {
    const node = db
      .prepare(
        "SELECT id, name, kind, file_path, start_line, end_line, exported FROM nodes WHERE id = ?"
      )
      .get(nodeId) as ParsedNode | undefined;
    if (!node) throw new Error(`Node not found: ${nodeId}`);
    return node;
  }
  if (!name) throw new Error("Either node_id or name must be provided.");
  const nodes = findSymbol(db, name, kind, true);
  if (nodes.length === 0)
    throw new Error(`No symbol found matching '${name}'.`);
  if (nodes.length > 1)
    throw new Error(
      `Ambiguous: ${nodes.length} symbols match '${name}'. ` +
        `Provide kind or use node_id. Matches: ${nodes.map((n) => `${n.name} (${n.kind} in ${n.file_path})`).join(", ")}`
    );
  return nodes[0]!;
}

// Row type returned by whyIsThisUsed — one row per traversal hop
export interface WhyRow {
  from_id: string;
  from_name: string;
  from_kind: string;
  relationship_type: string;
  to_id: string;
  to_name: string;
  to_kind: string;
  depth: number;
}

// Row type returned by explainImpact — node augmented with shortest depth
export type ImpactNode = ParsedNode & { depth: number };

// Return type for explainImpact (includes optional paths)
export interface ImpactResult {
  affected_nodes: ImpactNode[];
  paths: WhyRow[];
}

// Return type for getNeighbors
export interface Neighbors {
  edges: ParsedEdge[];
  nodes: ParsedNode[];
}

// Return type for queryArchitecture
export interface ArchitectureResult {
  defined_symbols: ParsedNode[];
  cross_file_edges: ParsedEdge[];
}

// findSymbol — locate symbols by name.
// exact=true (default): exact name match
// exact=false: prefix match (LIKE name%)
// kind: optional filter to a specific NodeKind
export function findSymbol(
  db: Database.Database,
  name: string,
  kind?: NodeKind,
  exact: boolean = true
): ParsedNode[] {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (exact) {
    conditions.push("name = ?");
    params.push(name);
  } else {
    conditions.push("name LIKE ? || '%'");
    params.push(name);
  }

  if (kind !== undefined) {
    conditions.push("kind = ?");
    params.push(kind);
  }

  const where = conditions.join(" AND ");
  const sql = `SELECT id, name, kind, file_path, start_line, end_line, exported
               FROM nodes
               WHERE ${where}
               ORDER BY file_path, name`;

  return db.prepare(sql).all(...params) as ParsedNode[];
}

// getNeighbors — one-hop neighbors of a node.
// direction: 'outgoing' (edges leaving the node), 'incoming' (edges entering), 'both'
// relationshipTypes: optional filter — only return edges of these types
export function getNeighbors(
  db: Database.Database,
  nodeId: string,
  direction: "incoming" | "outgoing" | "both",
  relationshipTypes?: EdgeType[]
): Neighbors {
  const typeFilter =
    relationshipTypes && relationshipTypes.length > 0
      ? `AND relationship_type IN (${relationshipTypes.map(() => "?").join(", ")})`
      : "";

  const typeParams = relationshipTypes ?? [];

  let edgeSql: string;
  let edgeParams: unknown[];

  if (direction === "outgoing") {
    edgeSql = `SELECT source_id, target_id, relationship_type
               FROM edges
               WHERE source_id = ? ${typeFilter}`;
    edgeParams = [nodeId, ...typeParams];
  } else if (direction === "incoming") {
    edgeSql = `SELECT source_id, target_id, relationship_type
               FROM edges
               WHERE target_id = ? ${typeFilter}`;
    edgeParams = [nodeId, ...typeParams];
  } else {
    // both — UNION ALL to include all edges in either direction
    edgeSql = `SELECT source_id, target_id, relationship_type
               FROM edges
               WHERE source_id = ? ${typeFilter}
               UNION ALL
               SELECT source_id, target_id, relationship_type
               FROM edges
               WHERE target_id = ? ${typeFilter}`;
    edgeParams = [nodeId, ...typeParams, nodeId, ...typeParams];
  }

  const edges = db.prepare(edgeSql).all(...edgeParams) as ParsedEdge[];

  // Collect all unique node IDs referenced by the returned edges
  const ids = new Set<string>();
  for (const edge of edges) {
    ids.add(edge.source_id);
    ids.add(edge.target_id);
  }

  if (ids.size === 0) {
    return { edges, nodes: [] };
  }

  const placeholders = Array.from(ids)
    .map(() => "?")
    .join(", ");
  const nodes = db
    .prepare(
      `SELECT id, name, kind, file_path, start_line, end_line, exported
       FROM nodes
       WHERE id IN (${placeholders})`
    )
    .all(...Array.from(ids)) as ParsedNode[];

  return { edges, nodes };
}

// explainImpact — blast-radius analysis.
// Returns all nodes that transitively depend on the given node (reverse traversal),
// each annotated with its shortest depth from the starting node.
// When includePaths is true, also returns per-hop path rows (same data as whyIsThisUsed).
// Cycle-safe: guarded by path accumulation and depth limit.
export function explainImpact(
  db: Database.Database,
  nodeId: string,
  maxDepth: number,
  includePaths: boolean = true
): ImpactResult {
  const affectedSql = `
    WITH RECURSIVE traversal(node_id, depth, path) AS (
      SELECT
        ?,
        0,
        ',' || ? || ','
      UNION ALL
      SELECT
        e.source_id,
        t.depth + 1,
        t.path || e.source_id || ','
      FROM edges e
      JOIN traversal t ON e.target_id = t.node_id
      WHERE t.depth < ?
        AND t.path NOT LIKE '%,' || e.source_id || ',%'
    )
    SELECT DISTINCT
      n.id, n.name, n.kind, n.file_path, n.start_line, n.end_line, n.exported,
      MIN(t.depth) AS depth
    FROM traversal t
    JOIN nodes n ON n.id = t.node_id
    WHERE t.node_id != ?
    GROUP BY n.id
    ORDER BY depth, n.file_path, n.name
  `;

  const affected_nodes = db
    .prepare(affectedSql)
    .all(nodeId, nodeId, maxDepth, nodeId) as ImpactNode[];

  let paths: WhyRow[] = [];
  if (includePaths) {
    paths = whyIsThisUsed(db, nodeId, maxDepth);
  }

  return { affected_nodes, paths };
}

// whyIsThisUsed — path chains answering "why does this symbol exist?".
// Returns one row per traversal hop so the caller can reconstruct dependency paths.
// Same CTE as explainImpact but selects source/target node data for each hop.
export function whyIsThisUsed(
  db: Database.Database,
  nodeId: string,
  maxDepth: number
): WhyRow[] {
  const sql = `
    WITH RECURSIVE traversal(node_id, depth, path, via_target, via_type) AS (
      SELECT
        ?,
        0,
        ',' || ? || ',',
        NULL,
        NULL
      UNION ALL
      SELECT
        e.source_id,
        t.depth + 1,
        t.path || e.source_id || ',',
        t.node_id,
        e.relationship_type
      FROM edges e
      JOIN traversal t ON e.target_id = t.node_id
      WHERE t.depth < ?
        AND t.path NOT LIKE '%,' || e.source_id || ',%'
    )
    SELECT
      t.node_id      AS from_id,
      src.name       AS from_name,
      src.kind       AS from_kind,
      t.via_type     AS relationship_type,
      t.via_target   AS to_id,
      dst.name       AS to_name,
      dst.kind       AS to_kind,
      t.depth        AS depth
    FROM traversal t
    JOIN nodes src ON src.id = t.node_id
    JOIN nodes dst ON dst.id = t.via_target
    WHERE t.depth > 0
    ORDER BY t.depth, src.name
  `;

  return db.prepare(sql).all(nodeId, nodeId, maxDepth) as WhyRow[];
}

// Return type for codebaseOverview
export interface OverviewResult {
  file_count: number;
  node_count: number;
  edge_count: number;
  node_kinds: { kind: string; count: number }[];
  edge_types: { relationship_type: string; count: number }[];
  top_called: {
    id: string;
    name: string;
    kind: string;
    file_path: string;
    caller_count: number;
  }[];
  top_imported: { file_path: string; importer_count: number }[];
  entry_points: { id: string; name: string; kind: string; file_path: string }[];
}

// codebaseOverview — structural summary of the entire indexed codebase.
// All data comes from aggregate SQL — no file reads.
// Returns counts, kind/type distributions, hot spots, and likely entry points.
export function codebaseOverview(db: Database.Database): OverviewResult {
  const file_count = (
    db.prepare("SELECT COUNT(*) AS n FROM files").get() as { n: number }
  ).n;

  const node_count = (
    db.prepare("SELECT COUNT(*) AS n FROM nodes").get() as { n: number }
  ).n;

  const edge_count = (
    db.prepare("SELECT COUNT(*) AS n FROM edges").get() as { n: number }
  ).n;

  const node_kinds = db
    .prepare(
      `SELECT kind, COUNT(*) AS count
       FROM nodes
       GROUP BY kind
       ORDER BY count DESC`
    )
    .all() as { kind: string; count: number }[];

  const edge_types = db
    .prepare(
      `SELECT relationship_type, COUNT(*) AS count
       FROM edges
       GROUP BY relationship_type
       ORDER BY count DESC`
    )
    .all() as { relationship_type: string; count: number }[];

  const top_called = db
    .prepare(
      `SELECT n.id, n.name, n.kind, n.file_path, COUNT(*) AS caller_count
       FROM edges e
       JOIN nodes n ON n.id = e.target_id
       WHERE e.relationship_type = 'CALLS'
       GROUP BY e.target_id
       ORDER BY caller_count DESC
       LIMIT 10`
    )
    .all() as {
    id: string;
    name: string;
    kind: string;
    file_path: string;
    caller_count: number;
  }[];

  const top_imported = db
    .prepare(
      `SELECT n.file_path, COUNT(*) AS importer_count
       FROM edges e
       JOIN nodes n ON n.id = e.target_id
       WHERE e.relationship_type = 'IMPORTS'
       GROUP BY n.file_path
       ORDER BY importer_count DESC
       LIMIT 10`
    )
    .all() as { file_path: string; importer_count: number }[];

  // Entry points: exported nodes that receive no incoming CALLS edges.
  // These are likely public API surfaces or CLI/server start points.
  const entry_points = db
    .prepare(
      `SELECT n.id, n.name, n.kind, n.file_path
       FROM nodes n
       WHERE n.exported = 1
         AND n.id NOT IN (
           SELECT target_id FROM edges WHERE relationship_type = 'CALLS'
         )
       ORDER BY n.file_path, n.name
       LIMIT 20`
    )
    .all() as { id: string; name: string; kind: string; file_path: string }[];

  return {
    file_count,
    node_count,
    edge_count,
    node_kinds,
    edge_types,
    top_called,
    top_imported,
    entry_points,
  };
}

// queryArchitecture — file-level view of defined symbols and cross-file relationships.
// includeInternalEdges=false (default): excludes edges where both ends are in the same file.
// includeInternalEdges=true: returns all edges sourced from nodes in the file.
export function queryArchitecture(
  db: Database.Database,
  filePath: string,
  includeInternalEdges: boolean
): ArchitectureResult {
  const defined_symbols = db
    .prepare(
      `SELECT id, name, kind, file_path, start_line, end_line, exported
       FROM nodes
       WHERE file_path = ?
       ORDER BY start_line`
    )
    .all(filePath) as ParsedNode[];

  let edgeSql: string;
  let edgeParams: unknown[];

  if (includeInternalEdges) {
    edgeSql = `SELECT e.source_id, e.target_id, e.relationship_type
               FROM edges e
               JOIN nodes n ON n.id = e.source_id
               WHERE n.file_path = ?
               ORDER BY e.source_id, e.target_id`;
    edgeParams = [filePath];
  } else {
    // Exclude edges where the target is also a node in the same file
    edgeSql = `SELECT e.source_id, e.target_id, e.relationship_type
               FROM edges e
               JOIN nodes n ON n.id = e.source_id
               WHERE n.file_path = ?
                 AND e.target_id NOT IN (
                   SELECT id FROM nodes WHERE file_path = ?
                 )
               ORDER BY e.source_id, e.target_id`;
    edgeParams = [filePath, filePath];
  }

  const cross_file_edges = db
    .prepare(edgeSql)
    .all(...edgeParams) as ParsedEdge[];

  return { defined_symbols, cross_file_edges };
}

// getImportersOf — return files that directly import the given file.
// Used for ripple invalidation when a file changes.
export function getImportersOf(
  db: Database.Database,
  filePath: string
): string[] {
  const importers = db
    .prepare(
      `SELECT DISTINCT n.file_path
       FROM nodes n
       JOIN edges e ON e.source_id = n.id
       WHERE e.target_id = ?
         AND e.relationship_type = 'IMPORTS'
       ORDER BY n.file_path`
    )
    .all(filePath) as { file_path: string }[];

  return importers.map((row) => row.file_path);
}
