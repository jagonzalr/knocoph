# Using Knocoph (Code Knowledge Graph)

This project is indexed with Knocoph. A persistent code knowledge graph is
available via MCP tools. Use graph tools first — before reading files. This
gives faster, more accurate structural answers and uses far fewer context tokens.

## Rule: graph before files

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

## Tool selection guide

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

## What not to do

- Do not read a source file before calling `find_symbol`. The graph answers
  structural questions with zero file-reading cost.
- Do not open a file to find a function signature. Use `get_snippet`
  with `start_line`/`end_line` from `find_symbol`.
- Do not call `explain_impact` with `max_depth` greater than 5 on large
  projects. High depth on large graphs is slow.

## Keeping the graph fresh

After the first `index_project` call, the file watcher keeps the graph
current automatically — even across process restarts. If the graph appears
stale, call `index_project { root_dir: "." }` again. Files that have not
changed are skipped instantly.
