/** A small, spec-following server-sent events parser over a fetch body. */

export interface SseEvent {
  event: string;
  data: string;
  id?: string;
}

/**
 * Yields events from a `text/event-stream` body. Handles CRLF/CR/LF line endings,
 * multi-line `data:` fields, comments, and a final event without a trailing blank line.
 */
export async function* parseSse(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let event = '';
  let data: string[] = [];
  let id: string | undefined;

  const flush = (): SseEvent | undefined => {
    if (data.length === 0) {
      event = '';
      return undefined;
    }
    const out: SseEvent = { event: event || 'message', data: data.join('\n'), id };
    event = '';
    data = [];
    return out;
  };

  const onLine = (line: string): SseEvent | undefined => {
    if (line === '') return flush();
    if (line.startsWith(':')) return undefined;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
    else if (field === 'id' && !value.includes('\0')) id = value;
    return undefined;
  };

  try {
    while (true) {
      if (signal?.aborted) throw signal.reason ?? new Error('aborted');
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let match: RegExpExecArray | null;
      const lineEnd = /\r\n|\r|\n/g;
      let start = 0;
      while ((match = lineEnd.exec(buffer)) !== null) {
        // A lone CR at the very end may be the first half of CRLF; wait for more input.
        if (match[0] === '\r' && match.index === buffer.length - 1) break;
        const ev = onLine(buffer.slice(start, match.index));
        start = match.index + match[0].length;
        if (ev) yield ev;
      }
      buffer = buffer.slice(start);
    }
    buffer += decoder.decode();
    for (const line of buffer.split(/\r\n|\r|\n/)) {
      const ev = onLine(line);
      if (ev) yield ev;
    }
    const last = flush();
    if (last) yield last;
  } finally {
    reader.releaseLock();
  }
}
