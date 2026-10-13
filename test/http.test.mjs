import assert from 'node:assert/strict';
import { request } from 'node:http';
import { after, before, test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { startHttpServer } from '../dist/http.js';
import { loadConfig } from '../dist/config.js';
import { KEY, startMockApi } from './mock-api.mjs';

let api;
let server;
let base;

before(async () => {
  api = await startMockApi();
  server = await startHttpServer(loadConfig({ ZEARCH_API_URL: api.url }), { host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise((r) => server.close(r));
  await api.close();
});

async function connect(token) {
  const client = new Client({ name: 'http-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : {},
  });
  await client.connect(transport);
  return client;
}

test('health check', async () => {
  const res = await fetch(`${base}/healthz`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).name, 'zearch-mcp');
});

test("each caller's key is used for their calls", async () => {
  const client = await connect(KEY);
  const result = await client.callTool({ name: 'get_wallet', arguments: {} });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.wallet.available, 412);
  const call = api.calls.findLast((c) => c.route === '/wallet');
  assert.equal(call.headers.authorization, `Bearer ${KEY}`);
  await client.close();
});

test('research streams progress over HTTP', async () => {
  const client = await connect(KEY);
  const progress = [];
  const result = await client.callTool({ name: 'research', arguments: { query: 'When did Webb launch?' } }, { onprogress: (p) => progress.push(p.message) });
  assert.equal(result.structuredContent.status, 'complete');
  assert.ok(progress.length > 0);
  await client.close();
});

test('a malformed bearer token is rejected with 401', async () => {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { Authorization: 'Bearer nope', 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: '{}',
  });
  assert.equal(res.status, 401);
  assert.match(res.headers.get('www-authenticate'), /invalid_token/);
});

test('without a key, listing works and keyed tools explain what is missing', async () => {
  const client = await connect();
  const { tools } = await client.listTools();
  assert.ok(tools.length >= 6);
  const result = await client.callTool({ name: 'get_wallet', arguments: {} });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /API key/);
  await client.close();
});

test('foreign Host headers are refused on a loopback bind', async () => {
  // fetch() won't override Host, so use node:http directly.
  const status = await new Promise((resolve, reject) => {
    const req = request(`${base}/mcp`, {
      method: 'POST',
      headers: { Host: 'evil.example', 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.end('{}');
  });
  assert.equal(status, 403);
});
