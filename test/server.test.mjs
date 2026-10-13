import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { ZearchClient, createZearchServer, UI_URI, UI_MIME_TYPE } from '../dist/server.js';
import { loadConfig } from '../dist/config.js';
import { KEY, startMockApi } from './mock-api.mjs';

let api;
let mcp;

async function connect(env) {
  const config = loadConfig({ ZEARCH_API_URL: api.url, ...env });
  const server = createZearchServer({ config, client: ZearchClient.fromConfig(config) });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(clientSide);
  return client;
}

const text = (result) => result.content.map((c) => c.text).join('\n');

before(async () => {
  api = await startMockApi();
  mcp = await connect({ ZEARCH_API_KEY: KEY });
});
after(async () => {
  await mcp.close();
  await api.close();
});

test('lists the tools with annotations, schemas and the answer view', async () => {
  const { tools } = await mcp.listTools();
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  assert.deepEqual(Object.keys(byName).sort(), ['get_pricing', 'get_run', 'get_wallet', 'list_runs', 'research', 'verify']);
  assert.equal(byName.research.annotations.readOnlyHint, false);
  assert.equal(byName.research.annotations.openWorldHint, true);
  assert.equal(byName.get_run.annotations.readOnlyHint, true);
  assert.deepEqual(byName.research.inputSchema.properties.mode.enum, ['standard', 'deep', 'compare', 'scrape', 'crawl', 'reverse']);
  assert.ok(byName.research.outputSchema);
  assert.equal(byName.research._meta.ui.resourceUri, UI_URI);
  assert.equal(byName.list_runs._meta?.ui, undefined);
});

test('research returns a checked answer with sources, and reports progress', async () => {
  const progress = [];
  const result = await mcp.callTool(
    { name: 'research', arguments: { query: 'When did the James Webb Space Telescope launch?' } },
    { onprogress: (p) => progress.push(p.message) },
  );
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.answer_type, 'verified');
  assert.equal(result.structuredContent.sources[0].n, 1);
  const out = text(result);
  assert.match(out, /Checked: all 1 paragraph supported/);
  assert.match(out, /\[1\] Webb mission \(science\.nasa\.gov · official source\)/);
  assert.match(out, /> Webb launched on Dec\. 25th 2021\./);
  assert.ok(progress.includes('Searching the web'), `progress was ${JSON.stringify(progress)}`);
});

test('modes that read a URL require one', async () => {
  const result = await mcp.callTool({ name: 'research', arguments: { query: 'What does it say?', mode: 'scrape' } });
  assert.equal(result.isError, true);
  assert.match(text(result), /needs a url/);
});

test('scrape forwards the url, and only https is accepted', async () => {
  const ok = await mcp.callTool({ name: 'research', arguments: { query: 'What does this page announce?', mode: 'scrape', url: 'https://example.com/news' } });
  assert.equal(ok.isError, undefined);
  assert.equal(api.calls.findLast((c) => c.route === '/research').body.url, 'https://example.com/news');
  const insecure = await mcp.callTool({ name: 'research', arguments: { query: 'q', mode: 'scrape', url: 'http://example.com' } });
  assert.equal(insecure.isError, true);
});

test('a standard question never sends a url', async () => {
  await mcp.callTool({ name: 'research', arguments: { query: 'q', url: 'https://example.com' } });
  assert.equal(api.calls.findLast((c) => c.route === '/research').body.url, undefined);
});

test('an excerpt answer is labelled as such', async () => {
  api.script['/research'] = [{ status: 200, body: { id: 'f'.repeat(32), status: 'complete', answer: '“Water boils at 100 °C at one atmosphere.” [1]', answer_type: 'excerpt', sources: [{ n: 1, title: 'Boiling point', excerpt: 'Water boils at 100 °C at one atmosphere.' }] } }];
  const result = await mcp.callTool({ name: 'research', arguments: { query: 'Boiling point on Everest?' } });
  assert.match(text(result), /couldn't verify an answer/);
});

test('verify reports per-paragraph results', async () => {
  const result = await mcp.callTool({
    name: 'verify',
    arguments: {
      question: 'How hot does water boil?',
      text: 'At sea level, water boils at 100 °C. [1]\n\nIt boils at 90 °C in Denver. [1]',
      sources: [{ title: 'Boiling point', text: 'Pure water boils at 100 °C at one atmosphere.' }],
    },
  });
  assert.equal(result.structuredContent.passed, false);
  const out = text(result);
  assert.match(out, /1 of 2 paragraphs not supported/);
  assert.match(out, /PASS ¶1/);
  assert.match(out, /FAIL ¶2/);
});

test('verify catches citations that point past the sources, before spending credits', async () => {
  const before = api.calls.length;
  const result = await mcp.callTool({ name: 'verify', arguments: { text: 'Claim. [3]', sources: [{ text: 'x' }] } });
  assert.equal(result.isError, true);
  assert.match(text(result), /cites \[3\] but only 1 source was given/);
  assert.equal(api.calls.length, before);
});

test('get_run, list_runs, wallet and pricing', async () => {
  const run = await mcp.callTool({ name: 'get_run', arguments: { id: '1'.padStart(32, '0') } });
  assert.equal(run.structuredContent.id, '1'.padStart(32, '0'));

  const bad = await mcp.callTool({ name: 'get_run', arguments: { id: 'not-an-id' } });
  assert.equal(bad.isError, true);

  const list = await mcp.callTool({ name: 'list_runs', arguments: { limit: 5 } });
  assert.ok(list.structuredContent.data.length >= 1);

  const wallet = await mcp.callTool({ name: 'get_wallet', arguments: { include_entries: true } });
  assert.equal(wallet.structuredContent.wallet.available, 412);
  assert.match(text(wallet), /Available: 412 credits \(5 held/);
  assert.match(text(wallet), /Recent entries/);

  const pricing = await mcp.callTool({ name: 'get_pricing', arguments: {} });
  assert.equal(pricing.structuredContent.object, 'pricing');
});

test('API errors become tool errors with next steps', async () => {
  api.script['/wallet'] = [{ status: 402, body: { error: { type: 'insufficient_credits', code: 'member_cap_reached', message: 'You have reached your monthly limit in the team pool.', request_id: 'req_cap' } } }];
  const result = await mcp.callTool({ name: 'get_wallet', arguments: {} });
  assert.equal(result.isError, true);
  assert.match(text(result), /team admin/);
});

test('resources: run template, listing, pricing and the answer view', async () => {
  const { resourceTemplates } = await mcp.listResourceTemplates();
  assert.ok(resourceTemplates.some((t) => t.uriTemplate === 'zearch://runs/{id}'));

  const { resources } = await mcp.listResources();
  assert.ok(resources.some((r) => r.uri === `zearch://runs/${'1'.padStart(32, '0')}`));
  assert.ok(resources.some((r) => r.uri === UI_URI && r.mimeType === UI_MIME_TYPE));

  const run = await mcp.readResource({ uri: `zearch://runs/${'1'.padStart(32, '0')}` });
  assert.match(run.contents[0].text, /Sources:/);

  const view = await mcp.readResource({ uri: UI_URI });
  assert.equal(view.contents[0].mimeType, UI_MIME_TYPE);
  assert.match(view.contents[0].text, /<html/i);
});

test('prompts', async () => {
  const { prompts } = await mcp.listPrompts();
  assert.deepEqual(prompts.map((p) => p.name).sort(), ['compare', 'fact_check', 'research_brief']);
  const brief = await mcp.getPrompt({ name: 'research_brief', arguments: { topic: 'solid-state batteries' } });
  assert.match(brief.messages[0].content.text, /mode "deep"/);
});

test('without a key, tools explain how to add one and the view can be turned off', async () => {
  const anon = await connect({ ZEARCH_UI: '0' });
  const result = await anon.callTool({ name: 'get_wallet', arguments: {} });
  assert.equal(result.isError, true);
  assert.match(text(result), /ZEARCH_API_KEY/);
  const { tools } = await anon.listTools();
  assert.equal(tools.find((t) => t.name === 'research')._meta?.ui, undefined);
  await anon.close();
});
