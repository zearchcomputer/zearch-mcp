// End to end over stdio: spawn the built CLI the way an MCP client does.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { after, before, test } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { KEY, startMockApi } from './mock-api.mjs';

const CLI = new URL('../dist/index.js', import.meta.url).pathname;
let api;

before(async () => {
  api = await startMockApi();
});
after(() => api.close());

test('--version and --help', () => {
  assert.match(execFileSync(process.execPath, [CLI, '--version']).toString(), /^\d+\.\d+\.\d+/);
  assert.match(execFileSync(process.execPath, [CLI, '--help']).toString(), /ZEARCH_API_KEY/);
});

test('serves tools over stdio and keeps stdout clean', async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI],
    env: { ...process.env, ZEARCH_API_KEY: KEY, ZEARCH_API_URL: api.url },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'stdio-test', version: '1.0.0' });
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.ok(tools.some((t) => t.name === 'research'));
  const result = await client.callTool({ name: 'research', arguments: { query: 'When did Webb launch?' } });
  assert.equal(result.structuredContent.answer_type, 'verified');
  await client.close();
});
