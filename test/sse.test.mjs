import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSse } from '../dist/sse.js';

function streamOf(...chunks) {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });
}

async function collect(stream) {
  const out = [];
  for await (const e of parseSse(stream)) out.push(e);
  return out;
}

test('parses events split across chunks, with comments and CRLF', async () => {
  const events = await collect(
    streamOf('event: sta', 'tus\r\ndata: {"text":"Sea', 'rching"}\r\n\r\n', ': keepalive\n\n', 'event: complete\ndata: {"id":"a"}\n\n'),
  );
  assert.deepEqual(
    events.map((e) => [e.event, e.data]),
    [
      ['status', '{"text":"Searching"}'],
      ['complete', '{"id":"a"}'],
    ],
  );
});

test('joins multi-line data and defaults the event name', async () => {
  const [e] = await collect(streamOf('data: one\ndata: two\n\n'));
  assert.equal(e.event, 'message');
  assert.equal(e.data, 'one\ntwo');
});

test('emits a final event that has no trailing blank line', async () => {
  const events = await collect(streamOf('event: delta\ndata: x'));
  assert.deepEqual(events.map((e) => e.data), ['x']);
});

test('a CR split from its LF across chunks is one line ending', async () => {
  const events = await collect(streamOf('event: a\r', '\ndata: 1\r', '\n\r', '\n'));
  assert.deepEqual(events.map((e) => [e.event, e.data]), [['a', '1']]);
});
