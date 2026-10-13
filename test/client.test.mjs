import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { ZearchClient, isTerminal } from '../dist/client.js';
import { describeError, ZearchError } from '../dist/errors.js';
import { normalizeApiUrl } from '../dist/config.js';
import { KEY, startMockApi } from './mock-api.mjs';

let api;
const sleeps = [];
const client = (over = {}) =>
  new ZearchClient({ apiKey: KEY, apiUrl: api.url, sleep: async (ms) => void sleeps.push(ms), ...over });

before(async () => {
  api = await startMockApi();
});
after(() => api.close());
beforeEach(() => {
  api.calls.length = 0;
  api.script = {};
  sleeps.length = 0;
});

test('research streams, reports progress and returns the finished run', async () => {
  const progress = [];
  let early;
  const run = await client().research({ query: 'When did Webb launch?' }, {
    onProgress: (p) => progress.push(p.message),
    onSources: (s) => (early = s),
  });
  assert.equal(run.status, 'complete');
  assert.equal(run.answer_type, 'verified');
  assert.equal(early.length, 1);
  assert.deepEqual(progress, ['Starting', 'Searching the web', 'Selected 1 source', 'Checking each claim against its source']);
  const call = api.calls.find((c) => c.route === '/research');
  assert.equal(call.body.stream, true);
  assert.match(call.headers['idempotency-key'], /^mcp_[a-f0-9]{32}$/);
  assert.match(call.headers['user-agent'], /^zearch-mcp\//);
});

test('a 500 is retried with the same idempotency key', async () => {
  api.script['/research'] = [{ status: 500, body: { error: { type: 'api_error', code: 'internal_error', message: 'boom', request_id: 'r' } } }];
  const run = await client().research({ query: 'q' });
  assert.equal(run.status, 'complete');
  const keys = api.calls.filter((c) => c.route === '/research').map((c) => c.headers['idempotency-key']);
  assert.equal(keys.length, 2);
  assert.equal(keys[0], keys[1]);
});

test('a replayed idempotent request comes back as JSON and is accepted', async () => {
  const c = client();
  const first = await c.research({ query: 'q' });
  // Simulate the stream response being lost after the server finished: replay the same key.
  const key = api.calls.find((x) => x.route === '/research').headers['idempotency-key'];
  const res = await fetch(`${api.url}/research`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Idempotency-Key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: 'q', stream: true }),
  });
  assert.equal(res.headers.get('idempotent-replayed'), 'true');
  assert.equal((await res.json()).id, first.id);
});

test('rate limits honour Retry-After', async () => {
  api.script['/wallet'] = [{ status: 429, headers: { 'Retry-After': '2' }, body: { error: { type: 'rate_limit_error', code: 'rate_limited', message: 'This key allows 60 requests per minute.', request_id: 'r' } } }];
  const wallet = await client().wallet();
  assert.equal(wallet.available, 412);
  assert.deepEqual(sleeps, [2000]);
});

test('402 is not retried and explains what to do', async () => {
  api.script['/research'] = [{ status: 402, body: { error: { type: 'insufficient_credits', code: 'insufficient_credits', message: 'This request needs 5 credits; 3 are available.', request_id: 'req_x' } } }];
  await assert.rejects(client().research({ query: 'q', mode: 'deep' }), (err) => {
    assert.ok(err instanceof ZearchError);
    assert.equal(err.status, 402);
    const text = describeError(err);
    assert.match(text, /out of credits/);
    assert.match(text, /zearch\.computer\/pricing/);
    assert.match(text, /req_x/);
    return true;
  });
  assert.equal(api.calls.filter((c) => c.route === '/research').length, 1);
});

test('a bad key is a clear authentication error', async () => {
  await assert.rejects(client({ apiKey: 'zk_test_wrongkey_000000' }).wallet(), (err) => {
    assert.equal(err.type, 'authentication_error');
    assert.match(describeError(err), /API key/);
    return true;
  });
});

test('no key configured fails before any network call', async () => {
  await assert.rejects(client({ apiKey: undefined }).wallet(), /ZEARCH_API_KEY/);
  assert.equal(api.calls.length, 0);
});

test('pricing needs no key', async () => {
  const pricing = await client({ apiKey: undefined }).pricing();
  assert.equal(pricing.object, 'pricing');
  assert.equal(api.calls[0].headers.authorization, undefined);
});

test('reverse runs are polled until they finish', async () => {
  api.pollsUntilDone = 2;
  const progress = [];
  const run = await client().research({ query: 'How does this app sync?', mode: 'reverse', url: 'https://example.com/app' }, {
    onProgress: (p) => progress.push(p.message),
    pollMs: 500,
  });
  assert.equal(run.status, 'complete');
  assert.ok(progress.includes('Queued for analysis'));
  const post = api.calls.find((c) => c.route === '/research');
  assert.equal(post.body.stream, false);
});

test('a stream that ends early falls back to reading the run', async () => {
  api.script['/research'] = ['drop'];
  const run = await client().research({ query: 'q' });
  assert.equal(run.status, 'complete');
  assert.ok(api.calls.some((c) => /^\/runs\/[a-f0-9]{32}$/.test(c.route)));
});

test('verify (no idempotency key) is not retried on a 500', async () => {
  api.script['/verify'] = [{ status: 500, body: { error: { type: 'api_error', code: 'internal_error', message: 'boom', request_id: 'r' } } }];
  await assert.rejects(client().verify({ text: 'x [1]', sources: [{ text: 'x' }] }));
  assert.equal(api.calls.filter((c) => c.route === '/verify').length, 1);
});

test('network failures on GET are retried, then reported plainly', async () => {
  const c = new ZearchClient({ apiKey: KEY, apiUrl: 'http://127.0.0.1:9/v1', sleep: async (ms) => void sleeps.push(ms), timeoutMs: 5000 });
  await assert.rejects(c.wallet(), (err) => {
    assert.equal(err.type, 'network_error');
    assert.match(describeError(err), /Couldn't reach Zearch/);
    return true;
  });
  assert.equal(sleeps.length, 2);
});

test('helpers', () => {
  assert.equal(isTerminal({ status: 'pending' }), false);
  assert.equal(isTerminal({ status: 'redacted' }), true);
  assert.equal(normalizeApiUrl('https://zearch.computer'), 'https://zearch.computer/v1');
  assert.equal(normalizeApiUrl('https://zearch.computer/v1/'), 'https://zearch.computer/v1');
  assert.equal(normalizeApiUrl('http://localhost:8765'), 'http://localhost:8765/v1');
  assert.throws(() => normalizeApiUrl('http://zearch.computer'), /https/);
});
