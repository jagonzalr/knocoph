# Knocoph

Knocoph is a local MCP server that parses TypeScript and JavaScript codebases
into a persistent knowledge graph stored in SQLite.

It exposes graph query tools via MCP's stdio transport so that AI assistants like
Claude Code can navigate codebases structurally, following call chains, import graphs,
and inheritance hierarchies rather than reading files greedily and burning context tokens.
