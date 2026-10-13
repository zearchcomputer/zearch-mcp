// A small stand-in for the Zearch v1 API, shaped after docs/openapi.yaml.
// Tests script its behaviour through `api.script` and inspect `api.calls`.
import { createServer } from 'node:http';

export const KEY = 'zk_test_mockkey_1234567890';
const ID = (n) => n.toString(16).padStart(32, '0');

export function makeRun(over = {}) {
  return {
    id: ID(1),
    object: 'research.run',
    status: 'complete',
    mode: 'standard',
    query: 'When did the James Webb Space Telescope launch?',
    parent_id: null,
    answer: 'The James Webb Space Telescope launched on December 25, 2021. [1]',
    answer_type: 'verified',
    verification: { gate: 'answer', paragraph_support: [0.96], paragraph_attribution: [0.91], model: 'jev-1.13.0' },
    sources: [
      {
        n: 1,
        url: 'https://science.nasa.gov/mission/webb/',
        title: 'Webb mission',
        domain: 'science.nasa.gov',
        excerpt: 'Webb launched on Dec. 25th 2021.',
        evidence_span: [10, 42],
        authority: 'official',
        capture_id: 'cap_1',
      },
    ],
    followups: ['Where does Webb orbit?'],
    error: null,
    timing_ms: 7743,
    created: 1791800000,
    updated: 1791800008,
    ...over,
  };
}

export async function startMockApi() {
  const api = {
    calls: [],
    /** Per-route queues of overrides: { status, body, headers } or 'drop' to close the stream early. */
    script: {},
    runs: new Map([[ID(1), makeRun()]]),
    seenIdem: new Map(),
    pollsUntilDone: 2,
  };
  const next = (route) => api.script[route]?.shift();

  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString();
    const body = raw ? JSON.parse(raw) : undefined;
    const url = new URL(req.url, 'http://x');
    const route = url.pathname.replace(/^\/v1/, '');
    api.calls.push({ method: req.method, route, headers: req.headers, body, query: Object.fromEntries(url.searchParams) });

    const send = (status, payload, headers = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'X-Request-Id': 'req_mock', ...headers });
      res.end(JSON.stringify(payload));
    };
    const err = (status, type, code, message, headers) =>
      send(status, { error: { type, code, message, request_id: 'req_mock' } }, headers);

    if (route === '/pricing') return send(200, { object: 'pricing', credits: { standard: 1, deep: 5 } });
    if (req.headers.authorization !== `Bearer ${KEY}`) return err(401, 'authentication_error', 'invalid_api_key', 'Invalid API key.');

    const override = next(route);
    if (override && override !== 'drop') return send(override.status, override.body, override.headers);

    if (route === '/research' && req.method === 'POST') {
      const idem = req.headers['idempotency-key'];
      if (idem && api.seenIdem.has(idem)) return send(200, api.seenIdem.get(idem), { 'Idempotent-Replayed': 'true' });
      const id = ID(api.runs.size + 1);
      if (body.mode === 'reverse') {
        const run = makeRun({ id, mode: 'reverse', status: 'pending', answer: null, answer_type: null, sources: [], verification: null, query: body.query });
        api.runs.set(id, run);
        api.polls = 0;
        return send(202, run, { Location: `/v1/runs/${id}` });
      }
      const run = makeRun({ id, mode: body.mode ?? 'standard', query: body.query, parent_id: body.parent_id ?? null });
      api.runs.set(id, run);
      if (idem) api.seenIdem.set(idem, run);
      if (!body.stream) return send(200, run);
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'X-Request-Id': 'req_mock' });
      const ev = (name, data) => res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
      ev('start', { id });
      res.write(': keepalive\n\n');
      ev('status', { text: 'Searching the web' });
      ev('sources', { sources: run.sources });
      ev('status', { text: 'Checking each claim against its source' });
      if (override === 'drop') return res.end();
      ev('delta', { text: run.answer });
      ev('complete', run);
      return res.end();
    }
    const runMatch = route.match(/^\/runs\/([a-f0-9]{32})$/);
    if (runMatch && req.method === 'GET') {
      const run = api.runs.get(runMatch[1]);
      if (!run) return err(404, 'not_found_error', 'run_not_found', 'No run with that id.');
      if (run.status === 'pending' && ++api.polls >= api.pollsUntilDone) {
        Object.assign(run, makeRun({ id: run.id, mode: run.mode, query: run.query }));
      }
      return send(200, run);
    }
    if (route === '/runs' && req.method === 'GET') {
      const data = [...api.runs.values()].reverse().slice(0, Number(url.searchParams.get('limit') ?? 20));
      return send(200, { object: 'list', data, has_more: false });
    }
    if (route === '/verify' && req.method === 'POST') {
      const paragraphs = body.text.split(/\n\s*\n/).map((text, index) => {
        const support = /90 °C/.test(text) ? 0.08 : 0.97;
        return { index, text, support, attribution: support > 0.5 ? 0.93 : 0.41, passed: support >= 0.75 };
      });
      return send(200, { object: 'verification', passed: paragraphs.every((p) => p.passed), threshold: 0.75, paragraphs, model: 'jev-1.13.0' });
    }
    if (route === '/wallet') {
      return send(200, { object: 'wallet', wallet: 'personal', plan: 'individual', available: 412, held: 5, member_cap: null,
        lots: [{ source: 'plan', remaining: 412, granted: 600, expires: 1794000000 }] });
    }
    if (route === '/wallet/entries') {
      return send(200, { object: 'list', entries: [{ kind: 'settle', reference: ID(1), credits: -1, member: null, at: 1791800008 }], next_before: null });
    }
    return err(404, 'not_found_error', 'route_not_found', `${req.method} /v1${route} is not an API route.`);
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  api.url = `http://127.0.0.1:${server.address().port}/v1`;
  api.close = () => new Promise((r) => server.close(r));
  return api;
}
