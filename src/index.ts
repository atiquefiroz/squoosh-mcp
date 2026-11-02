#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { config } from './config.js';
import { Engine } from './core/engine.js';
import { Sandbox } from './core/paths.js';
import { createServer } from './server.js';

const USAGE = `squoosh-mcp ${config.version}: MCP server for expert batch image optimisation (stdio).

Usage: squoosh-mcp <allowed-dir> [<allowed-dir> ...]

The server reads and writes only inside the allowed directories. With none given it uses
CLAUDE_PROJECT_DIR (unless that is your home folder or a filesystem root).

Environment: SQUOOSH_MCP_CONCURRENCY, SQUOOSH_MCP_INLINE_SECONDS, SQUOOSH_MCP_PIXEL_BUDGET_MP,
SQUOOSH_MCP_MAX_FILES, SQUOOSH_MCP_MAX_INPUT_MB`;

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.error(USAGE);
  process.exit(0);
}
if (args.includes('--version')) {
  console.error(config.version);
  process.exit(0);
}

const sandbox = await Sandbox.fromStartup(args, process.env.CLAUDE_PROJECT_DIR);
const engine = new Engine(sandbox);
serveStdio(() => createServer(engine));
console.error(`squoosh-mcp ${config.version} on stdio; allowed directories: ${sandbox.describe}`);
