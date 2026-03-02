# Knocoph

Knocoph (nok-of) is a local [MCP](https://modelcontextprotocol.io/) server that transforms TypeScript and JavaScript codebases into a persistent code knowledge graph stored in SQLite.

Instead of AI assistants greedily reading entire files and burning context tokens, Knocoph enables **structural codebase navigation** through deterministic graph queries. Navigate call chains, import graphs, inheritance hierarchies, and symbol dependencies with near-instant responses and minimal token consumption.

## Installation

Install globally so the `knocoph` command is available in PATH:

```bash
npm install -g knocoph
```

### Configuring the MCP server

Add Knocoph to your MCP client configuration (e.g. `.mcp.json`, `claude_desktop_config.json`):

```json
{
  "servers": {
    "knocoph": {
      "type": "stdio",
      "command": "knocoph",
      "env": {
        "knocoph_DB": "./.knocoph/graph.db",
        "knocoph_ROOT": "."
      }
    }
  }
}
```

Both `env` variables are **optional** — Knocoph uses sensible defaults if they are omitted:

| Variable       | Default               | Description                                                                                                                     |
| -------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `knocoph_DB`   | `./.knocoph/graph.db` | Path to the SQLite database file. Relative paths resolve from the working directory (the project root).                         |
| `knocoph_ROOT` | `.`                   | Root directory to auto-index on first run (before any `index_project` call). Relative paths resolve from the working directory. |

Minimal configuration with defaults (no `env` block required):

```json
{
  "servers": {
    "knocoph": {
      "type": "stdio",
      "command": "knocoph"
    }
  }
}
```

### Instructing AI assistants to use Knocoph

To guide your AI assistant (Claude, Copilot, etc.) to use Knocoph MCP tools effectively instead of reading files directly, copy the instructions from [MCP_USAGE.md](MCP_USAGE.md) into your AI assistant's system prompt, AGENTS.md, CLAUDE.md or equivalent configuration file.

These instructions teach AI to:

- Use `find_symbol` before opening files
- Use graph queries to understand relationships instead of burning context tokens
- Call `explain_impact` before making changes
- Use `get_snippet` to fetch exact code ranges rather than entire files

This approach minimizes token consumption and provides fast, accurate structural answers.

## Features

- **Persistent code graph** — parses codebases into nodes (symbols) and edges (relationships), stored in SQLite
- **Automatic indexing** — file watcher keeps the graph updated as code changes
- **Zero file reading** — query structural questions without opening source files
- **MCP tools** — 7 specialized query tools for different exploration patterns
- **Cross-file relationships** — tracks imports, exports, calls, inheritance, and containment

## How It Works

1. **Parse** — TypeScript ESLint parser extracts symbols, types, and relationships from source files
2. **Graph** — Builds nodes for functions, classes, interfaces, variables, etc.
3. **Store** — Persists all metadata and edges in SQLite
4. **Query** — Serve structural answers via MCP tools without re-parsing

## MCP Tools

| Tool                 | Purpose                                                                       |
| -------------------- | ----------------------------------------------------------------------------- |
| `codebase_overview`  | Get structural summary of entire codebase (files, symbols, kind distribution) |
| `find_symbol`        | Locate any symbol by name; optionally include source code snippet             |
| `get_neighbors`      | Explore incoming/outgoing relationships by symbol name or ID                  |
| `get_snippet`        | Fetch exact source code snippet for a symbol or line range                    |
| `explain_impact`     | Blast radius and dependency analysis; understand why a symbol exists          |
| `query_architecture` | File-level view — what symbols does a file define and import/export?          |
| `index_project`      | Trigger or refresh graph indexing for a codebase                              |

## Quick Reference

```bash
# Install globally
npm install -g knocoph

# Run tests (contributors)
npm run test:ci

# Format and lint (contributors)
npm run prettier
npm run lint
```

## Design Principles

- **Graph before files** — structural questions answered without file I/O
- **Deterministic queries** — same input always returns same result
- **Token efficiency** — small, precise responses instead of full file contents
- **Simplicity** — explicit, readable code over clever abstractions
