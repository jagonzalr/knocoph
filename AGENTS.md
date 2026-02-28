# Knocoph

This file defines expectations and constraints for AI-assisted development
in this repository. Follow these guidelines when proposing or modifying code.

## What

A local MCP knowledge codebase graph.

## Why

Implementing a local MCP server that transforms a codebase into a persistent
graph representation allows for deterministic reasoning, reduced token consumption,
and near-instant context retrieval, effectively mitigating the issues of context
bloat and token expenditure that plague traditional file-reading approaches.

## How

We use Node v24.13.1 for development.
If needed, run `nvm use 24.13.1`.

All code is written in Typescript with a focus on simplicity and readability.
Any developer should be able to understand the codebase without prior context.

Code guidelines:

- Prefer explicit, boring solutions over clever abstractions
- Avoid premature generalization
- Optimize for readability over minimal LOC

Design principles:

- KISS: implement the simplest solution that works today
- DRY: remove duplication only when it meaningfully improves readability or maintenance
- YAGNI: do not introduce abstractions, configuration, or extensibility for speculative future needs

When in doubt, prefer duplication over premature abstraction.

We write unit and integration tests for all new behavior and edge cases.
We aim for at least 80% coverage, but correctness and edge cases matter more
than the number itself.

After writing tests or verifying code changes, always run tests with:
`npm run test:ci`

After code changes, always validate formatting and linting:

- `npm run prettier` — run to keep consistent formatting across developers
- `npm run lint` — must pass with no errors or warnings
