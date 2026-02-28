import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type Database from "better-sqlite3";

import * as explainImpact from "./tools/explain-impact.js";
import * as findSymbol from "./tools/find-symbol.js";
import * as getNeighbors from "./tools/get-neighbors.js";
import * as getSnippet from "./tools/get-snippet.js";
import * as indexProject from "./tools/index-project.js";
import * as queryArch from "./tools/query-arch.js";
import * as whyIsThisUsed from "./tools/why-is-this-used.js";

export function createServer(db: Database.Database): McpServer {
  const server = new McpServer({
    name: "knocoph",
    version: "0.0.1",
  });

  findSymbol.register(server, db);
  getNeighbors.register(server, db);
  explainImpact.register(server, db);
  whyIsThisUsed.register(server, db);
  getSnippet.register(server, db);
  queryArch.register(server, db);
  indexProject.register(server, db);

  return server;
}
