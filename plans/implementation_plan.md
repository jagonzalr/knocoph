# Knocoph — Implementation Plan

**Last revised:** 2026-02-28

---

## Table of Contents

1. [Overview — What and Why](#1-overview)
2. [How MCP Works — stdio Transport, Lifecycle, the Localhost Question](#2-how-mcp-works)
3. [Architecture Overview](#3-architecture-overview)
4. [V1 Scope vs V2 Scope](#4-v1-scope-vs-v2-scope)
5. [Known Limitations — V1](#5-known-limitations)
6. [Schema Design](#6-schema-design)
7. [Edge Types](#7-edge-types)
8. [Tool Definitions](#8-tool-definitions)
9. [Real Engineering Challenges](#9-real-engineering-challenges)
10. [Build Setup — tsc Only, No Bundler](#10-build-setup)
11. [Testing Philosophy](#11-testing-philosophy)
12. [V1 Implementation PRs](#12-v1-implementation-prs)
13. [V2 Implementation PRs](#13-v2-implementation-prs)
14. [CLAUDE.md Behavioral Guidance](#14-claudemd-behavioral-guidance)

---

## 1. Overview

Knocoph is a local MCP server that parses TypeScript and JavaScript codebases into a persistent knowledge graph stored in SQLite. It exposes graph query tools via MCP's stdio transport so that AI assistants like Claude Code can navigate codebases structurally — following call chains, import graphs, and inheritance hierarchies rather than reading files greedily and burning context tokens.

**The problem it solves.** Without a code graph, an AI assistant asked "what calls `createUser`?" must either read every file (slow, expensive) or guess from memory (unreliable). With Knocoph, the answer is a single SQL query returning a precise list of callers in milliseconds. The graph also enables impact analysis before a change, reverse lookup to understand why a symbol exists, and file-level architectural views — all without loading source files into context.

**Target scale.** Repositories up to approximately 5,000 source files. SQLite with recursive CTEs handles this range comfortably without external infrastructure.

**Design constraints (non-negotiable):**

- KISS — the simplest solution that works today
- YAGNI — no abstractions for speculative future needs
- Readability — any developer should understand the code without prior context
- When in doubt, prefer duplication over premature abstraction

---

## 2. How MCP Works

This section answers: "When using it as a server, is it always running as localhost?"

### The short answer: No. stdio has nothing to do with localhost.

MCP supports multiple transport modes. Knocoph uses stdio. Here is the complete picture.

### stdio Transport (what Knocoph uses)

The MCP client — Claude Code, Claude Desktop, or any MCP host — reads a `.mcp.json` configuration file and **spawns the server as a child process** using the command you specify. Communication happens over the child process's **stdin and stdout** using newline-delimited JSON-RPC 2.0 messages. There is no HTTP server, no TCP port, no network socket of any kind.

**Full lifecycle:**

```
1. Claude Code starts up.
2. Claude Code reads .mcp.json and finds:
     { "command": "node", "args": ["./dist/index.js"] }
3. Claude Code forks: node ./dist/index.js as a child process.
4. The child process starts and waits for JSON-RPC messages on stdin.
5. Claude Code writes a JSON-RPC request to the child's stdin:
     {"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}
6. The child processes it and writes a response to its stdout:
     {"jsonrpc":"2.0","id":1,"result":{"tools":[...]}}
7. This repeats for every tool call during the session.
8. When Claude Code exits or the server is disabled:
     - Claude Code closes the child's stdin.
     - Waits a few seconds for the child to exit gracefully.
     - Sends SIGTERM if the child has not exited.
     - Sends SIGKILL if still alive after SIGTERM.
```

**Critical rule: stdout belongs to the protocol.** Writing anything non-JSON-RPC to stdout corrupts the protocol and silently breaks every tool call. All debug logging, startup messages, and error messages must go to **stderr** only. In Node.js, `console.error()` writes to stderr. `console.log()` writes to stdout — never use `console.log` anywhere in the server process.

**When does the server process die?** When the client process exits. The server is a child of the client. If Claude Code restarts — which happens routinely during a session — it re-spawns a fresh server process. This is why Knocoph auto-starts the file watcher on boot when the database already has indexed data. The watcher must come back to life along with the server, or the graph silently goes stale on every client restart.

### HTTP/SSE Transport (what Knocoph does NOT use)

For remote or shared servers, MCP supports HTTP with Server-Sent Events (SSE) or the newer Streamable HTTP transport introduced in the MCP 2025-03 spec. The server binds a TCP port and the client connects over the network. Average tool call latency is approximately 45ms for SSE versus approximately 12ms for stdio. Knocoph is a local personal tool — there is no reason to add network overhead or port management.

### The `.mcp.json` file

Place this in the root of any project you want to index:

```json
{
  "mcpServers": {
    "knocoph": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/knocoph/dist/index.js"],
      "env": {
        "knocoph_DB": "./.knocoph/graph.db",
        "knocoph_ROOT": "."
      }
    }
  }
}
```

**`knocoph_DB`** — path to the SQLite database file. Relative paths resolve from the working directory of the spawned process (the project root where `.mcp.json` lives). Default: `./.knocoph/graph.db`.

**`knocoph_ROOT`** — the project root directory. Used as the default when `index_project` is called without an explicit `root_dir`. Default: `.`.

Claude Code discovers `.mcp.json` automatically in the current directory and parent directories.

---

## 3. Architecture Overview

```
+--------------------------------------------------------------------+
|  Claude Code (MCP Client)                                          |
|                                                                    |
|  "find_symbol('UserService')"                                      |
|           | stdin JSON-RPC                                         |
+-----------+--------------------------------------------------------+
            | spawned child process
            v
+--------------------------------------------------------------------+
|  Knocoph Process  (node dist/index.js)                             |
|                                                                    |
|  +----------------+    +---------------------------------------+   |
|  |  MCP Layer     |    |  Tool Handlers  (src/tools/*.ts)      |   |
|  |  (server.ts)   |--->|  find-symbol      get-neighbors       |   |
|  |                |    |  explain-impact   why-is-this-used    |   |
|  |  stdio         |    |  get-snippet      query-arch          |   |
|  |  transport     |    |  index-project                        |   |
|  +----------------+    +--------------------+------------------+   |
|                                             |                      |
|              +--------------+--------------+---------------+       |
|              v              v                              v       |
|  +-----------+----+  +------+------------------+  +-------+----+  |
|  |  queries.ts    |  |  indexer.ts             |  | watcher.ts |  |
|  |  read-side SQL |  |  full scan +            |  |            |  |
|  |                |  |  incremental per-file   |  | chokidar   |  |
|  |  findSymbol    |  |                         |  | + debounce |  |
|  |  getNeighbors  |  |  +-------------------+  |  |            |  |
|  |  explainImpact |  |  |  parser.ts        |  |  | triggers   |  |
|  |  whyIsThisUsed |  |  |  ESTree AST walk  |  |  | indexFile  |  |
|  |  queryArch     |  |  |  symbol table     |  |  |            |  |
|  +-------+--------+  |  +-------------------+  |  +-----+------+  |
|          |           +-----------+-------------+        |         |
|          |                       |                      |         |
|          +-----------------------+----------------------+         |
|                                  v                               |
|  +---------------------------------------------------------------+ |
|  |  db.ts + graph.ts  (better-sqlite3)                           | |
|  |  openDatabase() -- WAL mode, foreign_keys ON                  | |
|  |  insertFile / insertNode / insertEdge / deleteFile            | |
|  +----------------------------------+----------------------------+ |
|                                     |                             |
+-------------------------------------|-----------------------------+
                                      v
                      +------------------------------+
                      |  .knocoph/graph.db           |
                      |  SQLite, WAL mode            |
                      |                              |
                      |  files   [v1]                |
                      |  nodes   [v1]                |
                      |  edges   [v1]                |
                      |  meta    [v1]                |
                      +------------------------------+

Tool call data flow:
  stdin -> server.ts -> tool handler -> queries.ts -> SQLite -> stdout

File change data flow:
  filesystem -> chokidar -> watcher.ts -> indexer.ts -> parser.ts -> graph.ts -> SQLite
```

**Layer responsibilities:**

| Layer        | File         | Responsibility                                                             |
| ------------ | ------------ | -------------------------------------------------------------------------- |
| Entry        | `index.ts`   | Open DB, auto-start watcher from meta config, create server, connect stdio |
| Protocol     | `server.ts`  | Instantiate McpServer, call register() for all 7 tool handlers             |
| Tools        | `tools/*.ts` | Zod input schemas, call one query or indexer function, format JSON output  |
| Queries      | `queries.ts` | All read-side SQL, recursive CTEs with cycle and depth protection          |
| Indexer      | `indexer.ts` | Full scan and per-file incremental indexing, hash-based skip               |
| Parser       | `parser.ts`  | ESTree AST walking, per-file symbol table, node and edge extraction        |
| Graph writes | `graph.ts`   | INSERT and DELETE functions, transaction wrapper                           |
| Database     | `db.ts`      | Open connection, WAL pragma, foreign_keys pragma, schema bootstrap         |
| Types        | `types.ts`   | Shared TypeScript interfaces — zero runtime code                           |
| Watcher      | `watcher.ts` | Chokidar setup, per-file debounce, trigger indexer on file events          |

---

## 4. V1 Scope vs V2 Scope

This table is the definitive scope boundary. Every feature is labeled. If a feature does not appear here it does not exist.

| Feature                                             | Version | Notes                                                |
| --------------------------------------------------- | ------- | ---------------------------------------------------- |
| SQLite schema: files, nodes, edges                  | **v1**  | Core schema                                          |
| SQLite schema: meta table                           | **v1**  | Stores watcher config for auto-start                 |
| IMPORTS edge type                                   | **v1**  |                                                      |
| EXPORTS edge type                                   | **v1**  |                                                      |
| CALLS edge type                                     | **v1**  | Name-based with import alias resolution              |
| EXTENDS edge type                                   | **v1**  |                                                      |
| IMPLEMENTS edge type                                | **v1**  |                                                      |
| CONTAINS edge type                                  | **v1**  | Class to method membership                           |
| REFERENCES edge type                                | **v2**  | Type annotation refs, variable refs, property access |
| `find_symbol` tool                                  | **v1**  |                                                      |
| `get_neighbors` tool                                | **v1**  |                                                      |
| `explain_impact` tool                               | **v1**  |                                                      |
| `why_is_this_used` tool                             | **v1**  |                                                      |
| `get_snippet` tool                                  | **v1**  |                                                      |
| `query_architecture` tool                           | **v1**  |                                                      |
| `index_project` tool                                | **v1**  |                                                      |
| Structured JSON output with summary field           | **v1**  | All tools                                            |
| Per-file symbol table with import alias tracking    | **v1**  | Handles `import { foo as bar }`                      |
| Dynamic import detection for string literal paths   | **v1**  | `import('./x.js')` handled                           |
| Re-export chain recording                           | **v1**  | Each hop recorded as separate edges                  |
| Auto-start watcher on server boot when DB has data  | **v1**  | Reads config from meta table                         |
| Per-file debounce on watcher events                 | **v1**  | 500ms timeout                                        |
| awaitWriteFinish stabilization                      | **v1**  | 200ms threshold                                      |
| In-memory LRU file cache for get_snippet            | **v1**  | Max 50 entries, ~20 lines                            |
| TypeScript compiler API for type resolution         | **v2**  | Deferred — full reasoning in section 9.6             |
| Semantic CALLS resolution for instance method calls | **v2**  | Requires TS Program API                              |
| tsconfig paths alias resolution                     | **v2**  |                                                      |
| Monorepo and workspace package support              | **v2**  | Single-project only in v1                            |
| Cross-file ripple invalidation                      | **v2**  | Re-index importers when a file changes               |
| Dead code detection                                 | **v2**  |                                                      |

---

## 5. Known Limitations

These are deliberate scope decisions, not bugs. Document each in a code comment near the relevant code path.

| Limitation                          | What you observe                                                                  | Why accepted                                                                                               | V2 path                                                 |
| ----------------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| No TypeScript type resolution       | Method calls `svc.create()` where `svc` is a local variable produce no CALLS edge | ESTree gives syntactic info only; type resolution requires the TS compiler API at 20x the performance cost | PR-V2-3: optional pass using ts.createProgram           |
| No tsconfig paths resolution        | Imports using `@myapp/auth` aliases produce dangling target edges                 | Path alias resolution requires tsconfig parsing; not worth v1 complexity                                   | PR-V2-4: accept optional tsconfig_path in index_project |
| No monorepo support                 | Cross-package edges are missing or dangling                                       | Single-project scope only; configure one .mcp.json per package                                             | Use one .mcp.json per package                           |
| No REFERENCES edges                 | Type annotation usages invisible to graph; blast radius underestimates            | Out of v1 scope                                                                                            | PR-V2-1: second AST pass                                |
| File-incremental only, no ripple    | When A changes, B's stale edges to A's old node IDs dangle until B is re-indexed  | Ripple invalidation requires reverse-import index and a queue                                              | PR-V2-5                                                 |
| Dynamic import with expression path | `import(getPath())` is dropped silently                                           | Cannot resolve expression paths statically                                                                 | Record with placeholder target                          |
| Re-export kind is approximate       | Re-export EXPORTS edges use kind `unknown` in target node ID                      | Would require re-parsing source file during re-export handling                                             | DB lookup for existing node kind                        |
| No duplicate symbol disambiguation  | Two files both defining `function foo` both appear in find_symbol results         | This is correct; use file_path field to distinguish                                                        | N/A                                                     |

---

## 6. Schema Design

```sql
-- Both pragmas must run on every new database connection.
-- SQLite disables foreign key enforcement by default.
-- Without PRAGMA foreign_keys = ON, ON DELETE CASCADE is silently ignored.
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

-- [v1] One row per indexed source file
CREATE TABLE IF NOT EXISTS files (
  path         TEXT PRIMARY KEY,   -- absolute path used consistently throughout
  content_hash TEXT NOT NULL,      -- SHA-256 hex digest of file contents
  indexed_at   INTEGER NOT NULL    -- Unix millisecond timestamp
) STRICT;

-- [v1] One row per extracted symbol
CREATE TABLE IF NOT EXISTS nodes (
  id         TEXT PRIMARY KEY,      -- sha256(file_path + ":" + name + ":" + kind)
  name       TEXT NOT NULL,         -- symbol name exactly as written in source
  kind       TEXT NOT NULL,         -- function | class | interface | type_alias | enum |
                                    -- namespace | method | constructor | arrow_function | variable
  file_path  TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,
  start_line INTEGER NOT NULL,      -- 1-indexed
  end_line   INTEGER NOT NULL,      -- 1-indexed
  exported   INTEGER NOT NULL DEFAULT 0   -- 1 if exported from module, 0 if internal
) STRICT;

-- [v1] One row per directed relationship between symbols
CREATE TABLE IF NOT EXISTS edges (
  source_id         TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  target_id         TEXT NOT NULL,   -- no FK -- allowed to dangle for external/unresolved targets
  relationship_type TEXT NOT NULL,   -- IMPORTS | EXPORTS | CALLS | EXTENDS | IMPLEMENTS | CONTAINS
  PRIMARY KEY (source_id, target_id, relationship_type)
) STRICT;

-- [v1] Key-value store for server configuration persistence.
-- Allows the file watcher to auto-start on server boot across Claude Code restarts.
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;
-- Keys used:
--   'root_dir'  TEXT  -- absolute path of the indexed project root
--   'globs'     TEXT  -- JSON array of glob patterns
--   'ignore'    TEXT  -- JSON array of ignore patterns

-- Indexes covering every query pattern used in queries.ts
CREATE INDEX IF NOT EXISTS idx_nodes_name      ON nodes(name);
CREATE INDEX IF NOT EXISTS idx_nodes_file_path ON nodes(file_path);
CREATE INDEX IF NOT EXISTS idx_edges_source    ON edges(source_id);
CREATE INDEX IF NOT EXISTS idx_edges_target    ON edges(target_id);
```

### Why CASCADE is the entire incremental update strategy

The key insight: deleting a file row automatically removes all derived data for that file.

```
Step 1: DELETE FROM files WHERE path = ?
  SQLite cascades: all nodes WHERE file_path = ? are deleted
  SQLite cascades: all edges WHERE source_id IN (those node ids) are deleted

Step 2: INSERT INTO files (path, content_hash, indexed_at) VALUES (?, ?, ?)
Step 3: INSERT INTO nodes ... (one row per extracted symbol)
Step 4: INSERT INTO edges ... (one row per extracted relationship)
```

All four steps run inside a single SQLite transaction. If anything after step 1 fails, the transaction rolls back and the database is left with the old data — stale but internally consistent. No partial writes.

This is why the incremental update code is simple: delete the file row, re-insert everything. No diff logic. No tracking of which nodes changed. The transaction handles atomicity.

**`PRAGMA foreign_keys = ON` must run before any writes.** Place it in `openDatabase()` in `db.ts`, unconditionally, immediately after opening the connection. Forgetting this pragma causes CASCADE to silently do nothing, which corrupts the graph over time as stale nodes accumulate.

### The meta table and auto-start rationale

When `index_project` completes successfully, the handler writes to `meta`:

- `root_dir`: absolute path of the indexed project
- `globs`: the glob patterns as a JSON array string
- `ignore`: the ignore patterns as a JSON array string

On server startup, `index.ts` reads these three rows. If all three are present, it calls `startWatcher()` before the MCP transport connects. The file watcher is already running when the first tool call arrives.

Without this: every Claude Code restart re-spawns the server process with no watcher running. Files saved after the restart are missed. The graph goes stale silently. The user must know to call `index_project` again after every restart to resume watching. With auto-start: none of that matters.

---

## 7. Edge Types

### V1 edge types

| Type         | Source                         | Target                                               | What it represents                                             |
| ------------ | ------------------------------ | ---------------------------------------------------- | -------------------------------------------------------------- |
| `IMPORTS`    | any node in the importing file | resolved absolute file path, or external module name | `import { foo } from './bar.js'` or dynamic `import('./x.js')` |
| `EXPORTS`    | file-level node                | the exported node's ID                               | `export function foo()` or `export { x } from './y.js'`        |
| `CALLS`      | function or method node        | called function or method node ID                    | `foo()` resolved via symbol table                              |
| `EXTENDS`    | class node                     | superclass node ID                                   | `class B extends A`                                            |
| `IMPLEMENTS` | class node                     | interface node ID                                    | `class C implements I`                                         |
| `CONTAINS`   | class node                     | method or constructor node ID                        | class-to-member membership                                     |

### V2 edge types

| Type         | What it represents                                                                             | Why deferred                                                                                                                |
| ------------ | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `REFERENCES` | Type annotation usage (`const x: Foo`), identifier usage in non-call position, property access | Requires careful AST handling to avoid false positives; adds many edges; validate v1 graph utility before adding more noise |

### Node ID computation

```
nodeId(filePath, name, kind) = sha256(filePath + ":" + name + ":" + kind)  [hex string]
```

Renaming a symbol changes its ID. Edges from other files that pointed to the old ID become dangling. The graph self-heals the next time those files are re-indexed.

### Target ID conventions

- Local symbol targets (CALLS, EXTENDS, IMPLEMENTS, CONTAINS, EXPORTS): `nodeId(targetFilePath, targetName, targetKind)`
- IMPORTS to a local file: the resolved absolute path string
- IMPORTS to an external module like `'zod'`: the module specifier string as-is
- Dangling targets (not in nodes table) are legal and expected

### Node kinds

`function` | `class` | `interface` | `type_alias` | `enum` | `namespace` | `method` | `constructor` | `arrow_function` | `variable`

---

## 8. Tool Definitions

All 7 tools are v1. Every tool returns a structured JSON object. The `summary` field is a short prose sentence readable by an LLM without parsing JSON. The structured fields are for programmatic use.

**Standard return format (all tools):**

```typescript
return {
  content: [
    {
      type: "text" as const,
      text: JSON.stringify({ summary, ...structuredData }, null, 2),
    },
  ],
};
```

**Standard error return (all tools):**

```typescript
return {
  content: [
    { type: "text" as const, text: JSON.stringify({ error: message }) },
  ],
  isError: true,
};
```

---

### Tool 1 — `find_symbol` [v1]

Entry point for all graph navigation. Locate a symbol by name. Always call this before opening files.

**Input:**

```typescript
{
  name: z.string().min(1),
  kind: z.enum([
    'function','class','interface','type_alias','enum',
    'namespace','method','constructor','arrow_function','variable'
  ]).optional(),
  exact: z.boolean().default(true)   // false = LIKE prefix match
}
```

**Output:**

```typescript
{
  summary: string,  // "Found 2 nodes matching 'UserService' (exact)."
  nodes: Array<{
    id: string,
    name: string,
    kind: string,
    file_path: string,
    start_line: number,
    end_line: number,
    exported: number
  }>
}
```

**SQL:** `WHERE name = ?` for exact, `WHERE name LIKE ? || '%'` for prefix. Append `AND kind = ?` when kind is provided.

---

### Tool 2 — `get_neighbors` [v1]

One-hop neighbors of a known node. Use this to see what a symbol calls, what calls it, what it imports, and what it extends.

**Input:**

```typescript
{
  node_id: z.string().min(1),
  direction: z.enum(['incoming', 'outgoing', 'both']).default('both'),
  relationship_types: z.array(
    z.enum(['IMPORTS','EXPORTS','CALLS','EXTENDS','IMPLEMENTS','CONTAINS'])
  ).optional()
}
```

**Output:**

```typescript
{
  summary: string,  // "UserService has 3 outgoing and 7 incoming edges."
  edges: Array<{ source_id: string, target_id: string, relationship_type: string }>,
  nodes: Array<{  // only nodes that exist in the nodes table (dangling targets excluded)
    id: string, name: string, kind: string,
    file_path: string, start_line: number, end_line: number
  }>
}
```

**SQL:** Outgoing: `WHERE source_id = ?`. Incoming: `WHERE target_id = ?`. Both: UNION ALL of the two. Append `AND relationship_type IN (...)` when relationship_types is provided. LEFT JOIN nodes to populate node data alongside edges.

---

### Tool 3 — `explain_impact` [v1]

Blast radius analysis. Reverse recursive traversal: "If I change this symbol, what else might break?" Returns all transitive callers and importers up to `max_depth` hops, deduplicated, each with their shortest depth.

**Input:**

```typescript
{
  node_id: z.string().min(1),
  max_depth: z.number().int().min(1).max(10).default(5)
}
```

**Output:**

```typescript
{
  summary: string,  // "createUser affects 12 symbols across 4 files up to depth 5."
  affected_nodes: Array<{
    id: string, name: string, kind: string, file_path: string,
    depth: number   // 1 = direct dependent, 2 = dependent's dependent, etc.
  }>
}
```

**SQL:** Recursive CTE traversing incoming edges. See section 9.7 for the exact template.

---

### Tool 4 — `why_is_this_used` [v1]

Reverse traversal formatted as path chains. Answers: "Why does this symbol exist? What depends on it?"

**Why two separate tools instead of one with a format parameter.** `explain_impact` answers "what is the blast radius?" and returns a flat list ordered by depth — optimized for pre-change risk assessment. `why_is_this_used` answers "why does this exist?" and returns the actual dependency paths as readable chains — optimized for understanding an unfamiliar symbol. An LLM in "assess risk" mode is different from one in "understand purpose" mode. A format parameter adds cognitive overhead at call time. Separate tools with clear names are self-documenting and invoke different reasoning modes.

**Input:**

```typescript
{
  node_id: z.string().min(1),
  max_depth: z.number().int().min(1).max(5).default(3)
}
```

**Output:**

```typescript
{
  summary: string,  // "createUser is referenced by 2 callers at depth 1."
  paths: Array<{
    from_id: string, from_name: string, from_kind: string,
    relationship_type: string,
    to_id: string, to_name: string, to_kind: string,
    depth: number
  }>
}
```

**SQL:** Same recursive CTE as `explain_impact` but the final SELECT returns edge-level rows (each traversal hop is one row) rather than a flat deduplicated node list. Default `max_depth` is 3, not 5, because path chains become hard to read beyond 3 hops.

---

### Tool 5 — `get_snippet` [v1]

Return exact source lines from a file. Use this after `find_symbol` returns `start_line` and `end_line` to read a function body without loading the whole file. This is the primary token-saving tool.

**Input:**

```typescript
{
  file_path: z.string().min(1),
  start_line: z.number().int().min(1),
  end_line: z.number().int().min(1),
  padding: z.number().int().min(0).max(20).default(2)  // extra context lines above and below
}
```

**Output:**

```typescript
{
  summary: string,  // "Lines 42-89 of user.service.ts (50 lines with 2 padding)."
  file_path: string,
  start_line: number,   // actual start after padding applied
  end_line: number,     // actual end after padding applied
  content: string       // the source lines as a single string with newlines
}
```

**Implementation:** No database query. Check the LRU cache for the file. If not cached, read with `fs.readFileSync`. Split on `'\n'`. Compute `actualStart = Math.max(0, startLine - 1 - padding)` and `actualEnd = Math.min(lines.length - 1, endLine - 1 + padding)`. Slice and rejoin with `'\n'`. Return with 1-indexed actual line numbers.

**LRU cache (module-level in `get-snippet.ts`):**

```typescript
const fileCache = new Map<string, string[]>(); // file path -> lines array
const MAX_CACHE_SIZE = 50;

function getFileLines(filePath: string): string[] {
  if (fileCache.has(filePath)) {
    const lines = fileCache.get(filePath)!;
    fileCache.delete(filePath); // remove from current position
    fileCache.set(filePath, lines); // re-insert at end (LRU promotion)
    return lines;
  }
  if (fileCache.size >= MAX_CACHE_SIZE) {
    fileCache.delete(fileCache.keys().next().value!); // evict oldest
  }
  const lines = fs.readFileSync(filePath, "utf-8").split("\n");
  fileCache.set(filePath, lines);
  return lines;
}
```

Maps preserve insertion order in JavaScript. The oldest entry is always at the front. No external library needed.

---

### Tool 6 — `query_architecture` [v1]

File-level view. What symbols a file defines and what cross-file relationships it participates in.

**Input:**

```typescript
{
  file_path: z.string().min(1),
  include_internal_edges: z.boolean().default(false)
}
```

**Output:**

```typescript
{
  summary: string,  // "user.service.ts defines 8 symbols and has 4 cross-file edges."
  defined_symbols: Array<{
    id: string, name: string, kind: string,
    start_line: number, end_line: number, exported: number
  }>,
  cross_file_edges: Array<{
    source_id: string, target_id: string, relationship_type: string
  }>
}
```

When `include_internal_edges = false` (default), edges where both source and target belong to the same file are excluded. CONTAINS edges (class to method) are the most common example of excluded internal edges.

---

### Tool 7 — `index_project` [v1]

Trigger a full or incremental index scan. Persists configuration to the meta table. Starts or restarts the file watcher.

**Input:**

```typescript
{
  root_dir: z.string().min(1),
  globs: z.array(z.string()).default(['**/*.ts','**/*.tsx','**/*.js','**/*.jsx']),
  ignore: z.array(z.string()).default([
    '**/node_modules/**',
    '**/dist/**',
    '**/build/**',
    '**/.git/**',
    '**/.knocoph/**'
  ])
}
```

**Output:**

```typescript
{
  summary: string,  // "Indexed 342 files in 4.2s: 189 updated, 153 unchanged, 0 errors."
  files_scanned: number,
  files_updated: number,
  files_skipped: number,
  files_errored: number,
  duration_ms: number,
  watcher_started: boolean
}
```

**Side effects in order:**

1. Resolve `root_dir` to an absolute path.
2. Call `indexProject(db, absoluteRoot, globs, ignore)`.
3. Write `root_dir`, `globs`, and `ignore` to the `meta` table with `INSERT OR REPLACE`.
4. Call `startWatcher(db, absoluteRoot, globs, ignore)`.

---

## 9. Real Engineering Challenges

### 9.1 AST Parsing Performance

**Problem.** `typescript-estree` is synchronous. Parsing thousands of files on first run occupies the event loop for several seconds.

**V1 strategy.** Accept the cost. For 5,000 files averaging 200 lines each, at approximately 100,000 lines per second, a cold full scan takes roughly 10 seconds. This is a one-time cost — subsequent runs skip files whose hash has not changed and complete in under a second.

Do not add async batching, worker threads, or `setImmediate` yielding. At our target scale these add complexity without meaningful benefit. KISS.

Log progress to stderr every 100 files: `console.error('[knocoph] Indexed 100/342 files...')`.

If a file throws during parsing, catch the error, log it, record status as `error`, and continue. Never crash the whole indexer over one bad file.

### 9.2 File Watching Correctness Under Rapid Changes

**Problem.** Editors do not always write files in a single OS write. Some use atomic rename (write to temp file, then rename). Some run formatting passes that produce multiple writes. Chokidar can fire multiple `change` events for one logical save.

**V1 strategy: two complementary layers.**

Layer 1 — `awaitWriteFinish`: chokidar waits until the file size is stable for 200ms before firing. Handles atomic rename and partial write patterns.

```typescript
chokidar.watch(pattern, {
  awaitWriteFinish: {
    stabilityThreshold: 200,
    pollInterval: 50,
  },
});
```

Layer 2 — per-file debounce: cancel and restart a 500ms timer on each new event for the same path.

```typescript
const pending = new Map<string, ReturnType<typeof setTimeout>>();

watcher.on("change", (filePath: string) => {
  const existing = pending.get(filePath);
  if (existing !== undefined) clearTimeout(existing);
  pending.set(
    filePath,
    setTimeout(() => {
      pending.delete(filePath);
      indexFile(db, path.resolve(rootDir, filePath));
    }, 500)
  );
});
```

Combined: `awaitWriteFinish` ensures we read a complete file. Per-file debounce ensures at most one re-parse per 500ms per file regardless of event count.

**Chokidar version:** `chokidar@^5` — ESM-native, requires Node 20+. We use Node 24.13.1.

### 9.3 Incremental Graph Consistency

**Problem.** When file A changes, its node IDs may change (IDs include the symbol name). File B has edges whose `target_id` values were computed from A's old node IDs. Those edges become dangling.

**How the schema handles it.** The `target_id` column in `edges` has no foreign key constraint — dangling edges are explicitly legal. After A is re-indexed, B's stale edges point to nothing. Queries that JOIN edges to nodes silently omit the dangling edges from results. The graph is slightly stale but never corrupt.

**Self-healing.** The next full `index_project` call re-indexes every file and corrects all stale edges.

**What v1 explicitly does not do.** Cross-file ripple invalidation. Deferred to PR-V2-5.

### 9.4 Dynamic Import Detection

`import('./foo.js')` does not appear as an `ImportDeclaration`. It is a `CallExpression` where `callee.type === 'Import'`.

Detection in `parser.ts`:

```
When visiting a CallExpression node:
  if node.callee.type === 'Import' AND node.arguments.length >= 1:
    arg = node.arguments[0]
    if arg.type === 'Literal' AND typeof arg.value === 'string':
      resolvedPath = path.resolve(path.dirname(filePath), arg.value)
      emit IMPORTS edge: currentFileNode -> resolvedPath
    else:
      console.error('[knocoph] unresolvable dynamic import in ' + filePath)
      // do not emit an edge
```

### 9.5 Re-Export Chains

`export { foo as bar } from './x.js'` is an `ExportNamedDeclaration` with both a `source` property and a `specifiers` array.

Handling:

1. Emit `IMPORTS` edge: current file -> resolved absolute path of `./x.js`.
2. For each specifier `{ local: Identifier, exported: Identifier }`:
   - Compute target ID: `sha256(resolvedSourcePath + ":" + specifier.local.name + ":unknown")`
   - Emit `EXPORTS` edge: current file node -> computed target ID.

The `unknown` kind is a deliberate imprecision — we do not re-parse the source file to determine the actual kind. The edge correctly records the re-export relationship. If the source file is indexed, graph traversal can follow through to the actual node.

Multi-hop re-export chains (A re-exports from B which re-exports from C) are recorded as separate hops. Following chains is a read-time graph traversal.

### 9.6 TypeScript Compiler API — Deferred to V2

**The question.** Should v1 include `ts.createProgram()` and `getTypeChecker()` to resolve method calls on object instances, e.g. `svc.create()` -> `UserService.create`?

**Why we defer.**

**Performance cost.** When `ts.createProgram([filePath], compilerOptions)` is called for a single file, TypeScript loads and type-checks the entire transitive dependency graph of that file. The TypeScript type checker operates at approximately 1,000 to 5,000 lines per second. `typescript-estree` pure parsing operates at approximately 100,000 lines per second. A 5,000-file project that takes 10 seconds for a syntactic scan could take several minutes with the type checker enabled. This is not acceptable for an on-demand developer tool.

**Node bridging complexity.** `typescript-estree` produces ESTree AST nodes. The TypeScript compiler API uses its own distinct AST node types. Bridging requires `parserServices`, a bridge layer built into `typescript-estree` when the `programs` option is set. This is non-trivial API surface that a junior engineer should not be expected to navigate correctly without prior experience in both systems.

**Configuration dependency.** `ts.createProgram()` requires `CompilerOptions`. Without a `tsconfig.json`, synthetic defaults must be provided. With one, it must be found and parsed. This opens the monorepo question (which tsconfig?) which is explicitly out of v1 scope.

**The right gap to leave.** The v1 per-file symbol table correctly handles the most common case: direct function calls to named and aliased imports. The gap — method calls on instances where the receiver is a local variable — is real but minor for a first version. The graph is genuinely useful without it.

**V2 path.** PR-V2-3: optional second pass using the TS compiler API, gated behind `knocoph_DEEP_RESOLVE=1` environment variable so it can be disabled when performance matters.

### 9.7 Per-File Symbol Table and Call Resolution

The original plan said "call targets resolved by name lookup after all nodes inserted." This breaks for two common patterns.

**Import alias:** `import { createUser as makeUser } from './service.js'; makeUser(data)` — a naive name lookup for `makeUser` finds nothing.

**Instance method call:** `const svc = new UserService(); svc.create(data)` — the receiver `svc` is a local variable; type resolution is required to know it is a `UserService`. This case is not solvable in v1.

**V1 strategy: three-pass parsing within each file.**

Pass 1 — collect imports:

```
For each ImportDeclaration:
  For each specifier:
    import { foo } from './bar.js'
      symbolTable.set('foo', { resolvedName: 'foo', sourceFile: resolvedAbsPath })
    import { foo as alias } from './bar.js'
      symbolTable.set('alias', { resolvedName: 'foo', sourceFile: resolvedAbsPath })
    import Default from './baz.js'
      symbolTable.set('Default', { resolvedName: 'default', sourceFile: resolvedAbsPath })
```

Pass 2 — collect local declarations:

```
For each top-level FunctionDeclaration, ClassDeclaration, etc:
  symbolTable.set(name, { resolvedName: name, sourceFile: null })
  // sourceFile: null means defined in this file
```

Pass 3 — resolve calls:

```
For each CallExpression:
  if callee is Identifier (foo()):
    entry = symbolTable.get(callee.name)
    if entry exists AND entry.sourceFile is not null:
      emit CALLS: currentNode -> nodeId(entry.sourceFile, entry.resolvedName, 'function')
    else if entry exists AND entry.sourceFile is null:
      emit CALLS: currentNode -> nodeId(currentFilePath, entry.resolvedName, 'function')
    else: drop (external call or unresolvable)

  if callee is MemberExpression (obj.method()):
    entry = symbolTable.get(object.name)
    if entry exists AND entry.sourceFile is not null:
      emit CALLS: currentNode -> nodeId(entry.sourceFile, callee.property.name, 'method')
    else: drop (instance method call -- requires type info -- see Known Limitations)
```

**What this correctly handles:** direct calls to imported functions, aliased imports, static-method-style calls where the receiver is itself an imported name.

**What this does not handle:** method calls where the receiver is a local variable, re-assigned variables, destructured imports used in calls, higher-order callbacks.

### 9.8 Recursive CTE Safety: Cycles and Depth Guards

Recursive CTEs loop indefinitely if the graph contains cycles. Code graphs do contain cycles — mutual recursion, circular re-exports.

Every recursive CTE in `queries.ts` must have all three protections:

**1. Depth guard.** `WHERE t.depth < ?` in the recursive step, bound to `maxDepth`.

**2. Cycle guard.** A `path` text column accumulating visited node IDs as a comma-delimited string (e.g. `,id1,id2,id3,`). In the recursive step: `AND t.path NOT LIKE '%,' || e.source_id || ',%'`. This prevents revisiting a node already in the current path.

**3. Deduplication.** `SELECT DISTINCT` and `MIN(t.depth) ... GROUP BY n.id` so nodes reachable at multiple depths appear once with their shortest depth.

**Exact template:**

```sql
WITH RECURSIVE traversal(node_id, depth, path) AS (
  SELECT
    ?,                   -- param 1: starting node_id
    0,
    ',' || ? || ','      -- param 2: same starting node_id (seeds the path string)
  UNION ALL
  SELECT
    e.source_id,
    t.depth + 1,
    t.path || e.source_id || ','
  FROM edges e
  JOIN traversal t ON e.target_id = t.node_id
  WHERE t.depth < ?                                    -- param 3: maxDepth
    AND t.path NOT LIKE '%,' || e.source_id || ',%'   -- cycle guard
)
SELECT DISTINCT
  n.id, n.name, n.kind, n.file_path, n.start_line, n.end_line,
  MIN(t.depth) AS depth
FROM traversal t
JOIN nodes n ON n.id = t.node_id
WHERE t.node_id != ?     -- param 4: starting node_id (exclude root from results)
GROUP BY n.id
ORDER BY depth, n.file_path, n.name;
```

Bind parameters in order: `[nodeId, nodeId, maxDepth, nodeId]`.

For `why_is_this_used`, the CTE body is identical but the final SELECT returns edge-level rows (source and target of each traversal hop) rather than the flat node list.

---

## 10. Build Setup

### Why Not Vite

The original plan used Vite in library mode. Vite is a browser bundler. For a Node.js process that runs alongside `node_modules/`, using Vite adds:

- An `externalize` configuration to prevent bundling native packages — a workaround for a problem that does not exist without a bundler
- Rollup overhead on every build: 2–5 seconds versus under 1 second for `tsc`
- A `vite.config.ts` file with browser-oriented concepts that have no place here

`tsc` compiles TypeScript source files to JavaScript in `dist/`. Node.js runs those files directly. `node_modules/` provides runtime dependencies. That is the complete picture. No bundler needed.

`vite.config.ts` does not exist in this project.

### tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitReturns": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "sourceMap": true,
    "declaration": false,
    "allowImportingTsExtensions": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

`declaration: false` — this is not a library published to npm. No `.d.ts` output is needed.

Tests are excluded from the main `tsconfig.json`. Vitest handles them separately.

### package.json (key fields)

```json
{
  "name": "knocoph",
  "description": "Knocoph is a local MCP server that parses TypeScript and JavaScript codebases into a persistent knowledge graph stored in SQLite.",
  "version": "0.0.1",
  "type": "module",
  "main": "./dist/index.js",
  "scripts": {
    "build": "tsc",
    "build:watch": "tsc --watch",
    "test": "vitest",
    "test:ci": "vitest run --coverage",
    "lint": "eslint src/",
    "prettier": "prettier --write src/ tests/"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "1.27.1",
    "@typescript-eslint/typescript-estree": "8.56.1",
    "better-sqlite3": "12.6.2",
    "chokidar": "5.0.0",
    "zod": "4.3.6"
  },
  "devDependencies": {
    "@types/better-sqlite3": "7.0.0",
    "@types/node": "22.0.0",
    "@vitest/coverage-v8": "2.0.0",
    "eslint": "10.0.2",
    "prettier": "3.8.1",
    "typescript": "5.9.3",
    "vitest": "4.0.18"
  }
}
```

### vitest.config.ts

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    pool: "forks",
    poolOptions: {
      forks: {
        // SQLite uses file-level locking for writes.
        // A single forked process prevents write contention between test files.
        singleFork: true,
      },
    },
    coverage: {
      provider: "v8",
      include: [
        "src/parser.ts",
        "src/queries.ts",
        "src/graph.ts",
        "src/indexer.ts",
      ],
      // Tool handlers, server.ts, watcher.ts, and index.ts are excluded.
      // They are thin glue code verified manually via MCP Inspector.
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 70,
      },
    },
  },
});
```

### Project structure

```
knocoph/
├── src/
│   ├── index.ts              Entry point
│   ├── server.ts             McpServer setup and tool registration
│   ├── db.ts                 Database open, pragmas, schema bootstrap
│   ├── parser.ts             ESTree AST walk, symbol table, node/edge extraction
│   ├── graph.ts              INSERT/DELETE functions, transaction wrapper
│   ├── indexer.ts            Full scan and per-file incremental index
│   ├── watcher.ts            Chokidar setup, per-file debounce
│   ├── queries.ts            All read-side SQL including recursive CTEs
│   ├── tools/
│   │   ├── find-symbol.ts
│   │   ├── get-neighbors.ts
│   │   ├── explain-impact.ts
│   │   ├── why-is-this-used.ts
│   │   ├── get-snippet.ts
│   │   ├── query-arch.ts
│   │   └── index-project.ts
│   └── types.ts              Shared interfaces -- zero runtime code
├── tests/
│   ├── graph.test.ts
│   ├── parser.test.ts
│   ├── indexer.test.ts
│   ├── queries.test.ts
│   └── fixtures/
│       ├── simple.ts             One of each node kind
│       ├── aliases.ts            Import alias in call expression
│       ├── reexports.ts          Re-export chain
│       ├── dynamic-imports.ts    Dynamic import with string literal
│       └── cross-file/
│           ├── a.ts              Exports a function
│           └── b.ts              Imports and calls that function
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── .mcp.json
└── .gitignore
```

No `vite.config.ts`. It does not exist in this project.

---

## 11. Testing Philosophy

This is a personal developer tool. The actual correctness test is: "Does Claude reason better about my codebase?" Mechanically chasing 90% coverage on glue code is waste.

### What to test thoroughly

These four modules contain all the logic that matters. Wrong behavior here produces a silently broken graph with no visible error.

| Module       | Why thorough testing is required                                                                                                                                                                                   |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `parser.ts`  | Wrong AST extraction means wrong graph. Every node kind and edge type must be verified against real TypeScript source. The import alias test is the most critical: it validates the entire symbol table mechanism. |
| `queries.ts` | Wrong SQL means wrong answers. Cycle bugs in recursive CTEs cause infinite loops with no error message. Depth limit bugs silently return too many or too few nodes.                                                |
| `graph.ts`   | CASCADE delete is the entire incremental update mechanism. If it fails silently (due to missing `PRAGMA foreign_keys = ON`), stale nodes accumulate indefinitely.                                                  |
| `indexer.ts` | Hash-based skip must be reliable. False skips leave stale data. False updates waste CPU. Error isolation must work so one bad file does not abort the whole scan.                                                  |

### What to test minimally or skip

| Module       | Why minimal or no tests                                                                                   |
| ------------ | --------------------------------------------------------------------------------------------------------- |
| `tools/*.ts` | Thin wiring: Zod schema plus one function call. Zero business logic. Verify manually via MCP Inspector.   |
| `server.ts`  | Calls `register()` seven times and returns. Zero logic. Skip.                                             |
| `watcher.ts` | Requires real filesystem events and real timers. Hard to make reliable. Skip unit tests; verify manually. |
| `index.ts`   | Startup wiring. Skip.                                                                                     |

### Coverage targets

80% lines and functions on `parser.ts`, `queries.ts`, `graph.ts`, and `indexer.ts`. 70% branches. Not on anything else. These numbers are already in `vitest.config.ts`.

### Test fixtures

Use real TypeScript source strings and real fixture files. Do not mock the AST. A fixture like `"export function foo() { bar(); }"` parsed through `typescript-estree` is a far better test than constructing a fake AST object by hand.

### Test database setup

Tests that need a database use `new Database(':memory:')` directly and run the schema SQL inline. They do not call `openDatabase()`. This keeps each test file independent of `db.ts` behavior.

### Running tests

`npm run test:ci` after every change. Must pass before committing. `singleFork: true` in vitest config ensures SQLite write locking is never an issue.

---

## 12. V1 Implementation PRs

Eight sequential PRs. Each touches 3–4 files. A junior engineer should be able to implement any one in a focused session of 2–4 hours. Each PR leaves the codebase compilable with all existing tests passing.

**Strict dependency order:** each PR depends on the previous one being merged.

PR-1 -> PR-2 -> PR-3 -> PR-4 -> PR-5 -> PR-6 -> PR-7 -> PR-8

---

### PR-1: Project Scaffolding

**Goal.** A compilable TypeScript project with correct configuration. `tsc` produces output. Vitest runs with zero tests and zero failures. Linting passes. No implementation code yet.

**Files to create:**

- `package.json`
- `tsconfig.json`
- `vitest.config.ts`
- `.gitignore`
- `.mcp.json`
- `src/types.ts`
- `src/index.ts` (stub only)

**Tasks:**

1. Create `package.json` with `"type": "module"`. Copy all dependencies and devDependencies from section 10 exactly. Include all scripts: `build`, `build:watch`, `test`, `test:ci`, `lint`, `prettier`.

2. Create `tsconfig.json` exactly as shown in section 10. No deviations.

3. Create `vitest.config.ts` exactly as shown in section 10.

4. Create `.gitignore` with at minimum: `node_modules/`, `dist/`, `.knocoph/`, `*.db`, `*.db-wal`, `*.db-shm`, `coverage/`.

5. Create `.mcp.json` using the template from section 2. Use `"./dist/index.js"` as the relative args path.

6. Create `src/types.ts` with zero runtime code. Export only `interface` and `type` declarations:
   - `NodeKind`: `'function' | 'class' | 'interface' | 'type_alias' | 'enum' | 'namespace' | 'method' | 'constructor' | 'arrow_function' | 'variable'`
   - `EdgeType`: `'IMPORTS' | 'EXPORTS' | 'CALLS' | 'EXTENDS' | 'IMPLEMENTS' | 'CONTAINS'`
   - `ParsedNode`: `{ id: string; name: string; kind: NodeKind; file_path: string; start_line: number; end_line: number; exported: number; }`
   - `ParsedEdge`: `{ source_id: string; target_id: string; relationship_type: EdgeType; }`
   - `ParsedFile`: `{ nodes: ParsedNode[]; edges: ParsedEdge[]; }`
   - `IndexStats`: `{ files_scanned: number; files_updated: number; files_skipped: number; files_errored: number; duration_ms: number; }`

7. Create `src/index.ts` as a single-line stub: `console.error('Knocoph starting...')`. Must be valid TypeScript with no imports.

8. Run `npm install`. Run `npm run build`. Fix any errors. Run `npm test`. Confirm zero tests and zero failures. Run `npm run lint`. Fix any warnings.

**Acceptance criteria:**

- `npm run build` exits 0 and produces `dist/index.js`
- `npm test` exits 0 with zero tests and zero failures
- `npm run lint` exits 0 with no warnings
- `src/types.ts` has no `any` types and no runtime code

---

### PR-2: Database Layer

**Goal.** SQLite schema bootstrap with WAL mode and CASCADE delete proven correct by in-memory database tests.

**Files to create:**

- `src/db.ts`
- `src/graph.ts`
- `tests/graph.test.ts`

**Tasks:**

1. `src/db.ts`: Export `openDatabase(dbPath: string): Database.Database`.
   - `const db = new Database(dbPath)`
   - `db.pragma('journal_mode = WAL')` — first statement after opening
   - `db.pragma('foreign_keys = ON')` — before any writes
   - `db.exec(SCHEMA_SQL)` — the complete schema from section 6 as a template literal constant named `SCHEMA_SQL` exported from this file so tests can reuse it
   - Return `db`
   - Idempotent: safe to call twice on the same file

2. `src/graph.ts`: Export five functions, each taking `db: Database.Database` as first param:
   - `insertFile(db, path: string, hash: string): void` — `INSERT OR REPLACE INTO files VALUES (?, ?, ?)` with `Date.now()` for `indexed_at`
   - `insertNode(db, node: ParsedNode): void` — `INSERT OR IGNORE INTO nodes VALUES (?, ?, ?, ?, ?, ?, ?)`
   - `insertEdge(db, edge: ParsedEdge): void` — `INSERT OR IGNORE INTO edges VALUES (?, ?, ?)`
   - `deleteFile(db, path: string): void` — `DELETE FROM files WHERE path = ?`
   - `writeTransaction(db: Database.Database, fn: () => void): void` — `db.transaction(fn)()`. Only place in the codebase where transactions are constructed.

3. `tests/graph.test.ts`: Each test uses `new Database(':memory:')` plus `db.pragma('foreign_keys = ON')` plus `db.exec(SCHEMA_SQL)` directly (import `SCHEMA_SQL` from `db.ts`). Do not call `openDatabase()`.

   Required tests:
   - **Cascade delete:** Insert file -> insert node with that `file_path` -> insert edge with that node as `source_id` -> `deleteFile` -> assert node row gone -> assert edge row gone. This is the most important test in the project.
   - **FK enforcement:** Insert a node with a `file_path` not in `files`. Expect thrown error containing "FOREIGN KEY constraint failed".
   - **Silent duplicate node:** `insertNode` twice with identical values. Expect no error. Assert exactly one row.
   - **Silent duplicate edge:** `insertEdge` twice with identical values. Expect no error. Assert exactly one row.
   - **WAL mode:** After `openDatabase()`, `db.pragma('journal_mode')` returns `'wal'`.
   - **FK enabled:** After `openDatabase()`, `db.pragma('foreign_keys')` returns `1`.
   - **Transaction rollback:** Inside `writeTransaction`, insert one node successfully then throw. Assert zero rows in `nodes`.

**Acceptance criteria:**

- `npm run test:ci` passes
- Cascade delete test explicitly asserts node and edge rows are absent after file deletion
- FK test proves inserting a node without a parent file row throws
- Transaction rollback test confirms atomicity

---

### PR-3: Parser

**Goal.** A pure parsing function with no database dependency. Extracts correct nodes and edges from TypeScript source including import aliases, re-exports, and dynamic imports. Proven by fixture-based tests.

**Files to create:**

- `src/parser.ts`
- `tests/parser.test.ts`
- `tests/fixtures/simple.ts`
- `tests/fixtures/aliases.ts`
- `tests/fixtures/reexports.ts`
- `tests/fixtures/dynamic-imports.ts`
- `tests/fixtures/cross-file/a.ts`
- `tests/fixtures/cross-file/b.ts`

**Tasks:**

1. Create fixture files first. Each must be valid TypeScript.

   **`tests/fixtures/simple.ts`:**

   ```typescript
   export interface User {
     id: string;
     name: string;
   }
   export type UserId = string;
   export enum Role {
     Admin = "admin",
     User = "user",
   }
   export class BaseService {
     protected log(msg: string): void {
       console.error(msg);
     }
   }
   export class UserService extends BaseService {
     constructor(private readonly role: Role) {
       super();
     }
     create(user: User): User {
       this.log("creating");
       return user;
     }
   }
   export function createUser(name: string): User {
     return { id: "1", name };
   }
   export const helper = (x: number) => x * 2;
   ```

   **`tests/fixtures/aliases.ts`:**

   ```typescript
   import { createUser as makeUser } from "./simple.js";
   export function registerUser(name: string) {
     return makeUser(name);
   }
   ```

   **`tests/fixtures/reexports.ts`:**

   ```typescript
   export { createUser as buildUser } from "./simple.js";
   ```

   **`tests/fixtures/dynamic-imports.ts`:**

   ```typescript
   export async function loadModule() {
     const mod = await import("./simple.js");
     return mod;
   }
   ```

   **`tests/fixtures/cross-file/a.ts`:**

   ```typescript
   export function doThing(x: number): number {
     return x * 2;
   }
   ```

   **`tests/fixtures/cross-file/b.ts`:**

   ```typescript
   import { doThing } from "./a.js";
   export function runThing() {
     return doThing(42);
   }
   ```

2. `src/parser.ts`: Export `parseFile(filePath: string, content: string): ParsedFile`.

   Unexported helpers in the same file:
   - `nodeId(filePath, name, kind)` — `createHash('sha256').update(filePath + ':' + name + ':' + kind).digest('hex')`
   - `walk(node, visitor)` — recursive walker. Call `visitor(node)` then iterate `Object.values(node)`, recursing into child nodes (non-null objects with a `type: string` property) and arrays of child nodes.
   - `buildSymbolTable(ast, filePath)` — Pass 1 (imports) and Pass 2 (local declarations) from section 9.7. Returns `Map<string, { resolvedName: string, sourceFile: string | null }>`.

   Wrap `parse(content, { jsx: true, loc: true, comment: false, range: false })` in try/catch — any error returns `{ nodes: [], edges: [] }`.

   Resolve relative import paths with `path.resolve(path.dirname(filePath), specifier)`. Leave external module names (no leading `.`) as-is.

   All local imports in `src/parser.ts` must end in `.js`.

3. `tests/parser.test.ts`: Load fixtures with `fs.readFileSync(fixturePath, 'utf-8')`. Pass the absolute path to `parseFile`. Assert exact field values.

   Required assertions:
   - `interface User` node: `kind === 'interface'`, `exported === 1`
   - `type UserId` node: `kind === 'type_alias'`
   - `enum Role` node: `kind === 'enum'`
   - `class UserService` node: `kind === 'class'`, `exported === 1`
   - `method create` node: `kind === 'method'`, `name === 'create'`
   - `constructor` node: `kind === 'constructor'`
   - `function createUser` node: `kind === 'function'`, `exported === 1`
   - `const helper` node: `kind === 'arrow_function'`
   - `UserService.start_line < UserService.end_line`
   - EXTENDS edge: source = `UserService` nodeId, target = `BaseService` nodeId
   - CALLS edge from `create` method to `log` method
   - IMPORTS edge from `aliases.ts` to resolved absolute path of `simple.ts`
   - **CALLS edge from `registerUser` to `createUser`** — the import alias test. `makeUser` is an alias. The edge must resolve to the `createUser` node in `simple.ts`. This is the critical test for the symbol table.
   - IMPORTS and EXPORTS edges from `reexports.ts`
   - IMPORTS edge from `dynamic-imports.ts`
   - IMPORTS edge from `cross-file/b.ts` to `cross-file/a.ts`
   - CALLS edge from `runThing` to `doThing`
   - Empty string: returns `{ nodes: [], edges: [] }` without throwing
   - Invalid syntax: returns `{ nodes: [], edges: [] }` without throwing

**Acceptance criteria:**

- `npm run test:ci` passes with 80%+ coverage on `src/parser.ts`
- Every node kind has at least one test
- Every v1 edge type has at least one test
- Import alias CALLS test passes
- `parseFile` never throws for any input

---

### PR-4: Indexer

**Goal.** Hash-based skip and incremental update pipeline. Integration-tested against real temporary directories.

**Files to create:**

- `src/indexer.ts`
- `tests/indexer.test.ts`

**Tasks:**

1. `src/indexer.ts`: Export two functions.

   `indexFile(db: Database.Database, filePath: string): { status: 'updated' | 'skipped' | 'error'; error?: string }`

   ```
   1. Try: content = fs.readFileSync(filePath, 'utf-8')
      Catch: return { status: 'error', error: e.message }
   2. hash = createHash('sha256').update(content).digest('hex')
   3. existing = db.prepare('SELECT content_hash FROM files WHERE path = ?')
                   .get(filePath) as { content_hash: string } | undefined
   4. if existing?.content_hash === hash: return { status: 'skipped' }
   5. Try: parsed = parseFile(filePath, content)
      Catch: return { status: 'error', error: e.message }
   6. Try: writeTransaction(db, () => {
            deleteFile(db, filePath)
            insertFile(db, filePath, hash)
            for (const n of parsed.nodes) insertNode(db, n)
            for (const e of parsed.edges) insertEdge(db, e)
          })
      Catch: return { status: 'error', error: e.message }
   7. return { status: 'updated' }
   ```

   `indexProject(db: Database.Database, rootDir: string, globs: string[], ignore: string[]): IndexStats`

   ```
   start = Date.now()
   Collect all matching file paths (use glob from 'node:fs/promises' if available on
   Node 24, otherwise add the 'glob' npm package). Resolve each to absolute path.
   stats = { files_scanned: 0, files_updated: 0, files_skipped: 0, files_errored: 0, duration_ms: 0 }
   For each file:
     stats.files_scanned++
     result = indexFile(db, absolutePath)
     increment the appropriate stats counter
     if stats.files_scanned % 100 === 0: console.error('[Knocoph] Indexed', stats.files_scanned, '...')
   stats.duration_ms = Date.now() - start
   return stats
   ```

2. `tests/indexer.test.ts`: Create temp dirs with `fs.mkdtempSync(path.join(os.tmpdir(), 'knocoph-test-'))`. Clean up in `afterEach` with `fs.rmSync(dir, { recursive: true, force: true })`. Fresh in-memory DB per test.

   Required tests:
   - **First index:** Write `export function hello() {}`. Call `indexFile`. Assert `status === 'updated'`. Assert node `hello` in `nodes`.
   - **Skip on no change:** Call `indexFile` again. Assert `status === 'skipped'`. Assert node count unchanged.
   - **Update on change:** Append a comment. Call `indexFile`. Assert `status === 'updated'`. Assert new hash stored.
   - **Symbol rename:** Change `hello` to `goodbye`. Call `indexFile`. Assert `goodbye` in `nodes`. Assert `hello` not in `nodes`.
   - **Error: invalid TS:** Write `"export { {{{broken"`. Call `indexFile`. Assert `status === 'error'`. Assert node count unchanged (no partial write).
   - **Error: file not found:** Call `indexFile` on nonexistent path. Assert `status === 'error'`.
   - **Full project scan:** Write 3 TS files. Call `indexProject`. Assert `files_updated === 3`.
   - **Incremental scan:** Call `indexProject` again unchanged. Assert `files_skipped === 3`.

**Acceptance criteria:**

- `npm run test:ci` passes with 80%+ coverage on `src/indexer.ts`
- Skip test: node count identical before and after second `indexFile` call
- Symbol rename test: old name absent, new name present
- Error test: node count identical before and after errored call
- No temp directories remaining after test suite

---

### PR-5: Query Layer

**Goal.** All read-side SQL in one module. Recursive CTEs with cycle and depth protection proven by seeded-data tests with known graph structures.

**Files to create:**

- `src/queries.ts`
- `tests/queries.test.ts`

**Tasks:**

1. `src/queries.ts`: Export five functions, each taking `db: Database.Database` as first param:

   `findSymbol(db, name: string, kind?: NodeKind, exact?: boolean): ParsedNode[]`

   `getNeighbors(db, nodeId: string, direction: 'incoming'|'outgoing'|'both', relationshipTypes?: EdgeType[]): { edges: ParsedEdge[]; nodes: ParsedNode[]; }`

   `explainImpact(db, nodeId: string, maxDepth: number): Array<ParsedNode & { depth: number }>`

   `whyIsThisUsed(db, nodeId: string, maxDepth: number): Array<{ from_id: string; from_name: string; from_kind: string; relationship_type: string; to_id: string; to_name: string; to_kind: string; depth: number; }>`

   `queryArchitecture(db, filePath: string, includeInternalEdges: boolean): { defined_symbols: ParsedNode[]; cross_file_edges: ParsedEdge[]; }`

2. `explainImpact`: Use the recursive CTE template from section 9.8 exactly. Bind parameters: `[nodeId, nodeId, maxDepth, nodeId]`.

3. `whyIsThisUsed`: Same CTE body but the final SELECT returns one row per traversal edge (join both source and target nodes to get names and kinds). Keep the CTE itself unchanged.

4. `queryArchitecture` cross-file filter when `includeInternalEdges = false`: append `AND source_id NOT IN (SELECT id FROM nodes WHERE file_path = ?) OR target_id NOT IN (SELECT id FROM nodes WHERE file_path = ?)` — or equivalently exclude edges where both nodes are in the same file via a subquery.

5. `tests/queries.test.ts`: Seed data directly using `insertFile`, `insertNode`, `insertEdge` from `graph.ts`. Do not use the parser. Fresh in-memory DB in `beforeAll` shared across all tests in the file.

   Required tests:

   `findSymbol`:
   - Exact match returns correct node
   - No match returns empty array
   - Prefix match (`exact: false`) returns all matching nodes
   - Kind filter narrows results

   `getNeighbors`:
   - Outgoing returns edge where `source_id` = given node
   - Incoming returns edge where `target_id` = given node
   - Both returns union
   - Relationship type filter returns only specified types
   - Dangling target: edge in `edges` array, not in `nodes` array

   `explainImpact`:
   - Linear chain A->B->C->D, depth 5: B at depth 1, C at depth 2, D at depth 3
   - Depth limit 2: only B and C — D must not be present
   - **Cycle test:** A->B, B->C, C->A. Call `explainImpact(A, 10)`. Must complete in under 100ms. At most 2 results (B and C; A excluded as root).
   - **Diamond test:** A->B, A->C, B->D, C->D. Call `explainImpact(A, 5)`. D appears exactly once.

   `whyIsThisUsed`:
   - A calls B: `whyIsThisUsed(B)` returns one path row with `from_name` = A's name, `to_name` = B's name, `depth === 1`
   - Two callers: two path rows

   `queryArchitecture`:
   - Two nodes in file X, one in file Y. One internal edge, one cross-file edge.
   - `includeInternalEdges = false`: only cross-file edge.
   - `includeInternalEdges = true`: both edges.

**Acceptance criteria:**

- `npm run test:ci` passes with 80%+ coverage on `src/queries.ts`
- Cycle test completes in under 100ms with `max_depth = 10`
- Depth limit test returns exactly the correct nodes
- Diamond DISTINCT test: D appears exactly once
- All functions tested with data-present and data-absent cases

---

### PR-6: MCP Tool Handlers

**Goal.** Wire query functions and indexer to MCP tool definitions. Each tool: Zod schema, one function call, one summary string, JSON return. Zero business logic in tool files.

**Files to create:**

- `src/tools/find-symbol.ts`
- `src/tools/get-neighbors.ts`
- `src/tools/explain-impact.ts`
- `src/tools/why-is-this-used.ts`
- `src/tools/get-snippet.ts`
- `src/tools/query-arch.ts`
- `src/tools/index-project.ts`

**Tasks:**

1. Each file exports one function: `register(server: McpServer, db: Database.Database): void`.

2. Every handler follows this exact structure — no deviations:

   ```typescript
   async (input) => {
     try {
       const data = theQueryFunction(db, ...relevantInputFields);
       const summary = buildSummary(data, input);
       return {
         content: [
           {
             type: "text" as const,
             text: JSON.stringify({ summary, ...data }, null, 2),
           },
         ],
       };
     } catch (e) {
       const message = e instanceof Error ? e.message : String(e);
       return {
         content: [
           { type: "text" as const, text: JSON.stringify({ error: message }) },
         ],
         isError: true,
       };
     }
   };
   ```

3. Implement Zod schemas exactly as specified in section 8.

4. **`get-snippet.ts`** — implement the LRU cache from section 8 (Tool 5) exactly as shown. Place the `fileCache` Map and `getFileLines` function at module level, outside `register`.

5. **`index-project.ts`** — after `indexProject()`:

   ```typescript
   const absoluteRoot = path.resolve(input.root_dir);
   const stats = indexProject(db, absoluteRoot, input.globs, input.ignore);
   db.prepare("INSERT OR REPLACE INTO meta VALUES ('root_dir', ?)").run(
     absoluteRoot
   );
   db.prepare("INSERT OR REPLACE INTO meta VALUES ('globs', ?)").run(
     JSON.stringify(input.globs)
   );
   db.prepare("INSERT OR REPLACE INTO meta VALUES ('ignore', ?)").run(
     JSON.stringify(input.ignore)
   );
   startWatcher(db, absoluteRoot, input.globs, input.ignore);
   ```

   Include `watcher_started: true` in the return data.

6. Summary string templates:
   - `find_symbol`: `Found ${nodes.length} node(s) matching '${input.name}'.`
   - `get_neighbors`: `Node has ${outCount} outgoing and ${inCount} incoming edge(s).`
   - `explain_impact`: `Affects ${affected_nodes.length} symbol(s) up to depth ${input.max_depth}.`
   - `why_is_this_used`: `Referenced by ${paths.length} path(s) up to depth ${input.max_depth}.`
   - `get_snippet`: `Lines ${actualStart}–${actualEnd} of ${path.basename(input.file_path)}.`
   - `query_architecture`: `Defines ${defined_symbols.length} symbol(s) with ${cross_file_edges.length} cross-file edge(s).`
   - `index_project`: `Indexed ${stats.files_scanned} file(s) in ${stats.duration_ms}ms: ${stats.files_updated} updated, ${stats.files_skipped} unchanged, ${stats.files_errored} error(s).`

7. No unit tests for tool handlers. Use MCP Inspector in PR-8.

**Acceptance criteria:**

- `npm run build` passes
- All 7 files follow identical structure — readable as a set, not just individually
- No logic in any handler beyond one function call into `queries.ts` or `indexer.ts`

---

### PR-7: Server, Watcher, and Entry Point

**Goal.** All modules wired into a running MCP server that auto-starts the file watcher and connects the stdio transport.

**Files to create or replace:**

- `src/server.ts`
- `src/watcher.ts`
- `src/index.ts` (replaces PR-1 stub)

**Tasks:**

1. `src/server.ts`:

   ```typescript
   import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
   import type Database from "better-sqlite3";
   import { register as registerFindSymbol } from "./tools/find-symbol.js";
   import { register as registerGetNeighbors } from "./tools/get-neighbors.js";
   import { register as registerExplainImpact } from "./tools/explain-impact.js";
   import { register as registerWhyIsThisUsed } from "./tools/why-is-this-used.js";
   import { register as registerGetSnippet } from "./tools/get-snippet.js";
   import { register as registerQueryArch } from "./tools/query-arch.js";
   import { register as registerIndexProject } from "./tools/index-project.js";

   export function createServer(db: Database.Database): McpServer {
     const server = new McpServer({ name: "Knocoph", version: "1.0.0" });
     registerFindSymbol(server, db);
     registerGetNeighbors(server, db);
     registerExplainImpact(server, db);
     registerWhyIsThisUsed(server, db);
     registerGetSnippet(server, db);
     registerQueryArch(server, db);
     registerIndexProject(server, db);
     return server;
   }
   ```

2. `src/watcher.ts`:

   ```typescript
   import chokidar, { type FSWatcher } from "chokidar";
   import path from "node:path";
   import type Database from "better-sqlite3";
   import { indexFile } from "./indexer.js";
   import { deleteFile } from "./graph.js";

   export let activeWatcher: FSWatcher | null = null;

   export function startWatcher(
     db: Database.Database,
     rootDir: string,
     globs: string[],
     ignore: string[]
   ): void {
     if (activeWatcher !== null) {
       activeWatcher.close();
       activeWatcher = null;
     }

     const pending = new Map<string, ReturnType<typeof setTimeout>>();

     const handleChange = (relativePath: string): void => {
       const absolutePath = path.resolve(rootDir, relativePath);
       const existing = pending.get(absolutePath);
       if (existing !== undefined) clearTimeout(existing);
       pending.set(
         absolutePath,
         setTimeout(() => {
           pending.delete(absolutePath);
           indexFile(db, absolutePath);
         }, 500)
       );
     };

     const watcher = chokidar.watch(globs, {
       cwd: rootDir,
       ignored: ignore,
       persistent: true,
       awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
     });

     watcher.on("add", handleChange);
     watcher.on("change", handleChange);
     watcher.on("unlink", (relativePath: string) => {
       deleteFile(db, path.resolve(rootDir, relativePath));
     });
     watcher.on("error", (err: unknown) => {
       console.error("[Knocoph] Watcher error:", err);
     });

     activeWatcher = watcher;
     console.error("[Knocoph] Watcher started for", rootDir);
   }
   ```

3. `src/index.ts`:

   ```typescript
   import fs from "node:fs";
   import path from "node:path";
   import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
   import { openDatabase } from "./db.js";
   import { createServer } from "./server.js";
   import { startWatcher, activeWatcher } from "./watcher.js";

   const dbPath = path.resolve(
     process.cwd(),
     process.env["knocoph_DB"] ?? "./.knocoph/graph.db"
   );
   fs.mkdirSync(path.dirname(dbPath), { recursive: true });

   const db = openDatabase(dbPath);
   console.error("[Knocoph] Database opened:", dbPath);

   // Auto-start the watcher if a previous index_project stored configuration.
   // This keeps the graph current across Claude Code restarts, which re-spawn
   // this process. Without this, the graph would go stale after every restart.
   const storedRoot = (
     db.prepare("SELECT value FROM meta WHERE key = 'root_dir'").get() as
       | { value: string }
       | undefined
   )?.value;
   const storedGlobs = (
     db.prepare("SELECT value FROM meta WHERE key = 'globs'").get() as
       | { value: string }
       | undefined
   )?.value;
   const storedIgnore = (
     db.prepare("SELECT value FROM meta WHERE key = 'ignore'").get() as
       | { value: string }
       | undefined
   )?.value;

   if (storedRoot && storedGlobs && storedIgnore) {
     console.error("[Knocoph] Auto-starting watcher for", storedRoot);
     startWatcher(
       db,
       storedRoot,
       JSON.parse(storedGlobs),
       JSON.parse(storedIgnore)
     );
   }

   const server = createServer(db);
   const transport = new StdioServerTransport();

   const shutdown = (): void => {
     activeWatcher?.close();
     db.close();
     process.exit(0);
   };
   process.on("SIGTERM", shutdown);
   process.on("SIGINT", shutdown);

   // Blocks until the transport closes (client disconnects or process is killed).
   await server.connect(transport);
   ```

**Acceptance criteria:**

- `npm run build` passes with no errors
- `node dist/index.js` starts without writing anything to stdout
- Manual stdio test — the following must return a JSON-RPC response listing exactly 7 tools on stdout with no other content:
  ```
  echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | node dist/index.js
  ```
- `kill -TERM <pid>` causes process to exit with code 0
- If `.knocoph/graph.db` has meta rows, watcher auto-starts (visible in stderr)

---

### PR-8: End-to-End Verification and CLAUDE.md Update

**Goal.** All 7 tools work correctly in a real TypeScript project. `CLAUDE.md` is updated with behavioral guidance. The tool is usable.

**Files to modify:**

- `CLAUDE.md` (add Knocoph section)

**Tasks:**

1. `npm run build` — confirm `dist/index.js` is current.

2. **MCP Inspector test:**

   ```
   npx @modelcontextprotocol/inspector node dist/index.js
   ```

   Open `localhost:6274`. Confirm all 7 tools listed, schemas match section 8, `index_project` returns expected JSON.

3. **Configure in a real project.** Add `.mcp.json`, start Claude Code.

4. **Sequential tool verification:**
   - `index_project { root_dir: "." }` — `files_updated > 0`, `watcher_started: true`
   - `find_symbol { name: "<known name>" }` — correct `file_path`, `start_line`, `end_line`
   - `get_snippet` using those values — content matches `sed -n '<start>,<end>p' <file>`
   - `get_neighbors { node_id }` — non-empty `edges` and `nodes`
   - `explain_impact { node_id }` — non-empty `affected_nodes`, completes in under 500ms
   - `why_is_this_used { node_id }` — non-empty `paths` for a non-leaf symbol
   - `query_architecture { file_path }` — non-empty `defined_symbols` and `cross_file_edges`

5. **Watcher test.** Modify a source file. Wait 1 second. Call `find_symbol` for the modified symbol. Confirm result reflects the change.

6. **Claude behavioral test.** In a fresh session, ask Claude to "find where `<SymbolName>` is defined." Confirm Claude calls `find_symbol` before `Read`.

7. Add the Knocoph guidance from section 14 to `CLAUDE.md`.

**Acceptance criteria:**

- All 7 tools return non-error JSON
- `get_snippet` content exactly matches raw source lines
- `explain_impact` completes under 500ms
- Watcher reflects file change within 1–2 seconds
- `CLAUDE.md` updated and committed

---

## 13. V2 Implementation PRs

Complete and validate all v1 PRs before starting any of these. "Validate" means using the tool in real coding sessions and confirming Claude uses it correctly and benefits from it.

---

### PR-V2-1: REFERENCES Edge Type

**Goal.** Track type annotation usages and non-call variable references. Completes blast radius analysis for non-call dependencies.

**Files:** `src/types.ts`, `src/parser.ts`, `tests/fixtures/`, `tests/parser.test.ts`

**Scope:**

- Add `'REFERENCES'` to `EdgeType` in `types.ts`
- Third AST walk pass in `parser.ts`: visit `TSTypeReference` nodes (type annotations) and `Identifier` nodes in non-call, non-import, non-declaration positions
- Resolve via symbol table using same alias tracking as CALLS
- Add `'REFERENCES'` to relationship_types enum in `get-neighbors.ts`
- `explain_impact` automatically includes REFERENCES edges once they exist
- New fixture `tests/fixtures/type-refs.ts`

**Known risk.** Identifier walk may produce false positives for shadowed names. Accept and document.

---

### PR-V2-2: Codebase Overview Tool

**Goal.** Expose a single `codebase_overview` tool that returns a structural summary of the entire indexed codebase from the DB. Replaces the need for an AI to call `query_architecture` on every file just to orient itself in an unfamiliar project.

**Why this and not `explain_codebase`.** "Explain" implies semantic understanding — what the code _does_, its domain, its architecture patterns. The DB stores only structural topology: nodes, edges, file paths. This tool delivers structural aggregates. Naming it `codebase_overview` is accurate; naming it `explain_codebase` would set a false expectation.

**Files to create or modify:**

- `src/queries.ts` — add `codebaseOverview(db): OverviewResult`
- `src/tools/codebase-overview.ts` — new tool handler, `register` function
- `src/server.ts` — call `registerCodebaseOverview`
- `src/tools/index-project.ts` — no change needed; meta table already stores root_dir
- `tests/queries.test.ts` — add `codebaseOverview` tests

**Tasks:**

1. Add `OverviewResult` interface to `src/queries.ts`:

   ```typescript
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
     entry_points: {
       id: string;
       name: string;
       kind: string;
       file_path: string;
     }[];
   }
   ```

2. Add `codebaseOverview(db: Database.Database): OverviewResult` to `src/queries.ts`. All data comes from aggregate SQL — no file reads. Queries to implement:

   ```sql
   -- file_count
   SELECT COUNT(*) AS n FROM files

   -- node_count
   SELECT COUNT(*) AS n FROM nodes

   -- edge_count
   SELECT COUNT(*) AS n FROM edges

   -- node_kinds
   SELECT kind, COUNT(*) AS count FROM nodes GROUP BY kind ORDER BY count DESC

   -- edge_types
   SELECT relationship_type, COUNT(*) AS count FROM edges GROUP BY relationship_type ORDER BY count DESC

   -- top_called (top 10 nodes by incoming CALLS edges)
   SELECT n.id, n.name, n.kind, n.file_path, COUNT(*) AS caller_count
   FROM edges e
   JOIN nodes n ON n.id = e.target_id
   WHERE e.relationship_type = 'CALLS'
   GROUP BY e.target_id
   ORDER BY caller_count DESC
   LIMIT 10

   -- top_imported (top 10 files by incoming IMPORTS edges)
   SELECT n.file_path, COUNT(*) AS importer_count
   FROM edges e
   JOIN nodes n ON n.id = e.target_id
   WHERE e.relationship_type = 'IMPORTS'
   GROUP BY n.file_path
   ORDER BY importer_count DESC
   LIMIT 10

   -- entry_points: exported nodes with zero incoming CALLS edges
   -- these are likely public API surfaces or CLI/server start points
   SELECT n.id, n.name, n.kind, n.file_path
   FROM nodes n
   WHERE n.exported = 1
     AND n.id NOT IN (
       SELECT target_id FROM edges WHERE relationship_type = 'CALLS'
     )
   ORDER BY n.file_path, n.name
   LIMIT 20
   ```

   Wrap all queries in a single function. No recursive CTEs needed — these are flat aggregates.

3. `src/tools/codebase-overview.ts`: Follow the identical handler structure used by every other tool file. Input schema has no required parameters. Call `codebaseOverview(db)` and return the result.

   ```typescript
   import { z } from "zod";
   import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
   import type Database from "better-sqlite3";
   import { codebaseOverview } from "../queries.js";

   export function register(server: McpServer, db: Database.Database): void {
     server.tool(
       "codebase_overview",
       "Return a structural summary of the entire indexed codebase: file and node counts, kind distribution, most-called functions, most-imported files, and likely entry points. Call this first when orienting in an unfamiliar project.",
       {},
       async () => {
         try {
           const result = codebaseOverview(db);
           const summary = `Codebase has ${result.file_count} file(s), ${result.node_count} symbol(s), and ${result.edge_count} edge(s).`;
           return {
             content: [
               {
                 type: "text",
                 text: JSON.stringify({ summary, ...result }, null, 2),
               },
             ],
           };
         } catch (err) {
           return {
             content: [
               { type: "text", text: JSON.stringify({ error: String(err) }) },
             ],
             isError: true,
           };
         }
       }
     );
   }
   ```

4. Register in `src/server.ts` alongside the other 7 tools. This brings the total to 8 tools.

5. Update the `tools/list` acceptance test in PR-7 to expect 8 tools instead of 7.

6. `tests/queries.test.ts`: Add `codebaseOverview` tests using the same seeded in-memory DB. Required cases:
   - Empty DB: all counts are 0, all arrays are empty, no throw.
   - Seeded with 2 files, 5 nodes, 3 CALLS edges: counts match exactly, top_called returns correct node with correct count, entry_points returns exported nodes that receive no CALLS.
   - entry_points cap test: seed 25 exported nodes with no callers; assert result length is 20.

**What this tool does NOT do:**

- No semantic explanation of what the code does — that requires LLM inference on source content, which is outside Knocoph's scope.
- No tsconfig or package.json reading — structural data only.
- No cross-project aggregation — one DB, one project.

**Acceptance criteria:**

- `npm run test:ci` passes with 80%+ coverage on the new `codebaseOverview` function
- Empty DB returns no error and all-zero counts
- Tool appears in MCP Inspector alongside the other 7 tools
- `codebase_overview` on a 100+ file project completes in under 100ms (all flat SQL, no recursion)
- Summary field is a single human-readable string; full data in structured fields alongside it

---

### PR-V2-3: TypeScript Compiler API for Semantic Call Resolution

**Goal.** Resolve method calls on instances (`svc.create()` -> `UserService.create`).

**Files:** `src/parser.ts`, new `src/resolver.ts`

**Design.** Gate behind `knocoph_DEEP_RESOLVE=1` env var.

When set:

1. After ESTree parse, collect unresolved MemberExpression call targets.
2. Create `ts.Program` per file: `ts.createProgram([filePath], { strict: false, skipLibCheck: true, noEmit: true })`.
3. Get `TypeChecker`.
4. Re-parse with `typescript-estree` using `programs` option to get `parserServices` (ESTree-to-TS-AST bridge).
5. For each unresolved call, use `checker.getTypeAtLocation(receiverTsNode)`, get symbol, get declaration, compute target node ID.
6. Emit additional CALLS edges.

**Performance.** Profile on 500-file project before releasing. If per-file program creation adds >10 seconds to a full scan, add a single shared `ts.Program` for the entire project run and reuse it.

**Complexity note.** Not suitable for a junior engineer working alone. Pair-program or assign to someone with prior experience in both `typescript-estree` and the TS compiler API.

---

### PR-V2-4: tsconfig Path Alias Resolution

**Goal.** Resolve imports using `compilerOptions.paths` mappings. Fixes dangling edges for `@myapp/auth`-style aliases.

**Files:** `src/tools/index-project.ts`, `src/indexer.ts`, `src/parser.ts`, `src/types.ts`

**Design:**

- Add optional `tsconfig_path?: string` to `index_project` Zod schema.
- Read and parse tsconfig (strip line comments with a regex before `JSON.parse` for JSONC support).
- Extract `compilerOptions.paths`. Pass to `parseFile` as optional argument.
- In `parseFile`, before standard relative resolution, check paths map. Handle `@scope/*` -> `./src/*` wildcard via prefix replacement. Document that complex patterns beyond prefix replacement are not supported.

---

### PR-V2-5: Cross-File Ripple Invalidation

**Goal.** When file A changes, re-index all files that directly import A.

**Files:** `src/queries.ts`, `src/watcher.ts`

**Design:**

- Add to `queries.ts`:
  ```sql
  -- getImportersOf(db, filePath)
  SELECT DISTINCT n.file_path
  FROM nodes n
  JOIN edges e ON e.source_id = n.id
  WHERE e.target_id = ?
    AND e.relationship_type = 'IMPORTS'
  ```
- In `watcher.ts`, after debounced `indexFile(db, changedPath)` completes, call `getImportersOf`. Add each returned path to `pending` with 1000ms delay (longer than primary 500ms).
- Cap at 20 importers. If more: log warning `[Knocoph] Skipping ripple for <path> (>20 importers)` and skip. Prevents cascading re-indexing of widely-used utilities.
- One level of ripple only (direct importers). Transitive ripple is out of scope.

---

## 14. CLAUDE.md Behavioral Guidance

Add this section verbatim to `CLAUDE.md` in any project using Knocoph. Without this guidance, Claude Code defaults to reading files, which defeats the purpose of having a graph.

```markdown
## Using Knocoph (Code Knowledge Graph)

This project is indexed with Knocoph. A persistent code knowledge graph is
available via MCP tools. Use graph tools first — before reading files. This
gives faster, more accurate structural answers and uses far fewer context tokens.

### Rule: graph before files

1. Call `find_symbol` to locate any symbol by name before opening any file.
2. Call `get_neighbors` to explore what a symbol calls and what calls it,
   before reading the file it lives in.
3. Call `get_snippet` with `start_line` and `end_line` from `find_symbol`
   to read a specific function or class body. Only open full files when
   you need context outside that snippet.
4. Call `explain_impact` before modifying any symbol to understand what
   else might break.
5. Call `why_is_this_used` before deleting or refactoring an unfamiliar
   symbol to understand why it exists.

### Tool selection guide

| Question                               | Tool                                               |
| -------------------------------------- | -------------------------------------------------- |
| Where is `UserService` defined?        | `find_symbol { name: "UserService" }`              |
| What does `UserService` call?          | `get_neighbors { node_id, direction: "outgoing" }` |
| What calls `UserService`?              | `get_neighbors { node_id, direction: "incoming" }` |
| Show me the body of `create`           | `get_snippet { file_path, start_line, end_line }`  |
| What breaks if I change `createUser`?  | `explain_impact { node_id }`                       |
| Why does `createUser` exist?           | `why_is_this_used { node_id }`                     |
| What does this file export and import? | `query_architecture { file_path }`                 |
| Graph returns empty results            | `index_project { root_dir: "." }`                  |

### What not to do

- Do not call `Read` on a source file before calling `find_symbol`. The
  graph answers structural questions with zero file-reading cost.
- Do not open a file to find a function signature. Use `get_snippet`
  with `start_line`/`end_line` from `find_symbol`.
- Do not call `explain_impact` with `max_depth` greater than 5 on large
  projects. High depth on large graphs is slow.

### Keeping the graph fresh

After the first `index_project` call, the file watcher keeps the graph
current automatically — even across Claude Code restarts. If the graph
appears stale, call `index_project { root_dir: "." }` again. Files that
have not changed are skipped instantly.
```

---

_End of implementation plan._
