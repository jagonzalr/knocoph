export type NodeKind =
  | "function"
  | "class"
  | "interface"
  | "type_alias"
  | "enum"
  | "namespace"
  | "method"
  | "constructor"
  | "arrow_function"
  | "variable";

export type EdgeType =
  | "IMPORTS"
  | "EXPORTS"
  | "CALLS"
  | "EXTENDS"
  | "IMPLEMENTS"
  | "CONTAINS"
  | "REFERENCES";

export interface ParsedNode {
  id: string;
  name: string;
  kind: NodeKind;
  file_path: string;
  start_line: number;
  end_line: number;
  exported: number;
}

export interface ParsedEdge {
  source_id: string;
  target_id: string;
  relationship_type: EdgeType;
}

export interface ParsedFile {
  nodes: ParsedNode[];
  edges: ParsedEdge[];
}

export interface IndexStats {
  files_scanned: number;
  files_updated: number;
  files_skipped: number;
  files_errored: number;
  duration_ms: number;
}
