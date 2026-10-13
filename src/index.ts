#!/usr/bin/env node
/**
 * zearch-mcp: run the Zearch MCP server.
 *
 *   zearch-mcp                     stdio (for Claude Desktop, Claude Code, Cursor, VS Code…)
 *   zearch-mcp --http [--port N]   Streamable HTTP at http://127.0.0.1:N/mcp
 *
 * Logs go to stderr only; stdout belongs to the protocol in stdio mode.
 */
import { parseArgs } from 'node:util';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { ZearchClient } from './client.js';
import { VERSION, loadConfig } from './config.js';
import { startHttpServer } from './http.js';
import { createZearchServer } from './server.js';

const HELP = `zearch-mcp ${VERSION}: research with answers you can check, over MCP.

Usage:
  zearch-mcp                       Serve over stdio (default)
  zearch-mcp --http                Serve Streamable HTTP at /mcp
      --port <n>                   Port (default: $PORT or 8787)
      --host <addr>                Interface (default: 127.0.0.1)
      --allowed-hosts <a,b>        Host header values to accept on a public interface
  zearch-mcp --help | --version

Environment:
  ZEARCH_API_KEY          Your Zearch API key (zk_live_…). In HTTP mode, callers send their own.
  ZEARCH_API_URL          API base URL (default https://zearch.computer/v1)
  ZEARCH_TIMEOUT_MS       Per-request timeout (default 120000)
  ZEARCH_REVERSE_WAIT_MS  How long research waits for a Reverse engineer run (default 300000)
  ZEARCH_UI               Set to 0 to turn off the inline answer view
`;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      http: { type: 'boolean', default: false },
      port: { type: 'string' },
      host: { type: 'string', default: '127.0.0.1' },
      'allowed-hosts': { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', short: 'v', default: false },
    },
    strict: true,
  });

  if (values.help) return void process.stdout.write(HELP);
  if (values.version) return void process.stdout.write(`${VERSION}\n`);

  const config = loadConfig();

  if (values.http) {
    const port = Number(values.port ?? process.env.PORT ?? 8787);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid port: ${values.port}`);
    const allowedHosts = (values['allowed-hosts'] ?? process.env.ZEARCH_MCP_ALLOWED_HOSTS ?? '')
      .split(',')
      .map((h) => h.trim())
      .filter(Boolean);
    const server = await startHttpServer(config, { host: values.host!, port, allowedHosts });
    console.error(`zearch-mcp ${VERSION} listening on http://${values.host}:${port}/mcp (API ${config.apiUrl})`);
    const stop = () => server.close(() => process.exit(0));
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    return;
  }

  if (!config.apiKey) {
    console.error('zearch-mcp: ZEARCH_API_KEY is not set. Tools that need a key will explain how to add one.');
  }
  const client = ZearchClient.fromConfig(config);
  serveStdio(() => createZearchServer({ config, client }), {
    onerror: (err) => console.error(`zearch-mcp: ${err.message}`),
  });
}

main().catch((err: unknown) => {
  console.error(`zearch-mcp: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
