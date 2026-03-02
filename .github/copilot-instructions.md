# Using Knocoph (Code Knowledge Graph)

This project is indexed with Knocoph. A persistent code knowledge graph is available via MCP tools. Use graph tools first — before reading files. This gives faster, more accurate structural answers and uses far fewer context tokens.

## Rule: graph before files

1. Call `find_symbol` to locate any symbol by name. Use `include_snippet: true`
   to get the source code in the same call.
2. Call `get_neighbors` with a symbol `name` or `node_id` to explore what it
   calls and what calls it, before reading the file it lives in.
3. Call `explain_impact` with a symbol `name` or `node_id` before modifying any
   symbol to understand blast radius and dependency paths.
4. Call `codebase_overview` at the start of any analysis to understand the
   project's structure, file count, symbol distribution, and top-level architecture.
5. Call `query_architecture` to understand what symbols a file defines and what
   it imports/exports before reading the file.
6. Call `get_snippet` to read specific lines from a file when you have
   file_path and line numbers from a previous tool result.
7. Call `index_project` if the graph appears stale after code changes.

## Tool selection guide

| Question                               | Tool                                                           |
| -------------------------------------- | -------------------------------------------------------------- |
| Overview of symbols and relationships? | `codebase_overview { }`                                        |
| Where is `UserService` defined?        | `find_symbol { name: "UserService" }`                          |
| Show me the body of `create`           | `find_symbol { name: "create", include_snippet: true }`        |
| What does `UserService` call?          | `get_neighbors { name: "UserService", direction: "outgoing" }` |
| What calls `UserService`?              | `get_neighbors { name: "UserService", direction: "incoming" }` |
| What breaks if I change `createUser`?  | `explain_impact { name: "createUser" }`                        |
| Why does `createUser` exist?           | `explain_impact { name: "createUser" }`                        |
| What does this file export and import? | `query_architecture { file_path }`                             |
| Read lines 50-80 of a file             | `get_snippet { file_path, start_line: 50, end_line: 80 }`      |
| Graph returns empty results            | `index_project { root_dir: "." }`                              |

## What not to do

- Do not read a source file before calling `find_symbol`. The graph answers structural questions with zero file-reading cost.
- Do not open a file to find a function signature. Use `get_snippet` with `start_line`/`end_line` from `find_symbol`.
- Do not call `explain_impact` with `max_depth` greater than 5 on large projects. High depth on large graphs is slow.

## Keeping the graph fresh

After the first `index_project` call, the file watcher keeps the graph current automatically — even across process restarts. If the graph appears stale, call `index_project { root_dir: "." }` again. Files that have not changed are skipped instantly.
