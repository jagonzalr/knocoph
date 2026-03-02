# knocoph

## 1.3.0

### Minor Changes

- 2c74df9: Cross-File Ripple Invalidation

  When file A changes, re-index all files that directly import A.

## 1.2.0

### Minor Changes

- a7a7097: Tool Consolidation

  Reduce average tool calls per question from 2–3 to 1 by adding name-based resolution, merging `why_is_this_used` into `explain_impact`, and adding `include_snippet` to `find_symbol`. Drop from 8 → 7 tools.

## 1.1.1

### Patch Changes

- 7632691: Make knocoph executable for global installations

## 1.1.0

### Minor Changes

- 32e3e1b: Codebase Overview Tool

  ## What

  Expose a single `codebase_overview` tool that returns a structural summary of the
  entire indexed codebase from the DB. Replaces the need for an AI to call `query_architecture`
  on every file just to orient itself in an unfamiliar project.

## 1.0.0

### Major Changes

- 82f4a39: # Knocoph v1.0.0 — Structural Codebase Navigation for AI

  ## What

  Knocoph is a local [MCP](https://modelcontextprotocol.io/) server that transforms TypeScript and JavaScript codebases into a persistent code knowledge graph stored in SQLite.

  Instead of AI assistants greedily reading entire files and burning context tokens, Knocoph enables **structural codebase navigation** through deterministic graph queries — eliminating file I/O costs and answering context questions with minimal token consumption.

  ## Why

  Traditional approaches to codebase exploration waste tokens and context:
  - AI assistants read entire files to answer simple structural questions
  - Context bloat accumulates from redundant file reads
  - Token expenditure skyrockets with codebase size

  Knocoph inverts this model. By pre-indexing your codebase into a persistent knowledge graph, you answer structural questions deterministically and instantly — no file reads required.

  Navigate call chains, import graphs, inheritance hierarchies, and symbol dependencies with near-zero latency and zero token waste.

  ## How

  **Parse** — TypeScript/JavaScript parser extracts symbols, types, and relationships from source code.

  **Graph** — Builds nodes for functions, classes, interfaces, variables, and more. Edges represent calls, imports, exports, inheritance, and containment.

  **Store** — Persists all metadata in SQLite for deterministic queries and automatic caching.

  **Query** — Seven specialized MCP tools (`find_symbol`, `get_neighbors`, `get_snippet`, `explain_impact`, `why_is_this_used`, `query_architecture`, `index_project`) serve structural answers without re-parsing or file access.

  **Watch** — Automatic file watcher keeps the graph synchronized as code evolves.

  ## Features
  - Persistent code graph stored in SQLite
  - Zero file reading — answer structural questions from the graph alone
  - Automatic indexing with file watcher
  - 7 specialized query tools for different exploration patterns
  - Cross-file relationship tracking (imports, exports, calls, inheritance, containment)
  - Near-instant query responses
  - Deterministic results — same input always returns the same answer
