import type Database from "better-sqlite3";

import type { EdgeType, NodeKind, ParsedEdge, ParsedNode } from "./types.js";

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
// Cycle-safe: guarded by path accumulation and depth limit.
// Bind order: [nodeId, nodeId, maxDepth, nodeId]
export function explainImpact(
  db: Database.Database,
  nodeId: string,
  maxDepth: number
): ImpactNode[] {
  const sql = `
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

  return db.prepare(sql).all(nodeId, nodeId, maxDepth, nodeId) as ImpactNode[];
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
