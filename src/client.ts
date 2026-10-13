/**
 * A dependency-free client for the Zearch API (v1).
 *
 * - Every POST /research carries an Idempotency-Key that is reused across retries,
 *   so a retried request never runs, or charges, twice.
 * - Retries cover network failures, 5xx and per-minute rate limits, with jittered
 *   exponential backoff that honours Retry-After.
 * - Research streams by default so callers can report progress; replayed requests
 *   and queued Reverse engineer runs come back as plain JSON and are handled too.
 */
import { randomUUID } from 'node:crypto';
import { VERSION, type ZearchConfig } from './config.js';
import { ZearchError, errorFromResponse } from './errors.js';
import { parseSse } from './sse.js';
import type {
  Entries,
  ResearchProgress,
  ResearchRequest,
  Run,
  RunList,
  Source,
  Verification,
  VerifyRequest,
  Wallet,
} from './types.js';

export interface ClientOptions {
  apiKey?: string;
  apiUrl: string;
  timeoutMs?: number;
  /** Retries after the first attempt, for retryable failures. */
  maxRetries?: number;
  fetch?: typeof fetch;
  /** Override for tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface CallOptions {
  signal?: AbortSignal;
}

export interface ResearchOptions extends CallOptions {
  onProgress?: (progress: ResearchProgress) => void;
  /** Called with the sources as soon as Jev has selected them, before the answer is checked. */
  onSources?: (sources: Source[]) => void;
  /** How long to wait for a queued (Reverse engineer) run before returning it unfinished. */
  waitMs?: number;
  /** Poll interval floor for queued runs. */
  pollMs?: number;
}

const TERMINAL = new Set(['complete', 'error', 'interrupted', 'redacted']);

export function isTerminal(run: Pick<Run, 'status'>): boolean {
  return TERMINAL.has(run.status);
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export class ZearchClient {
  readonly apiUrl: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(options: ClientOptions) {
    this.apiUrl = options.apiUrl.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.sleep = options.sleep ?? defaultSleep;
  }

  static fromConfig(config: ZearchConfig, apiKey = config.apiKey): ZearchClient {
    return new ZearchClient({ apiKey, apiUrl: config.apiUrl, timeoutMs: config.timeoutMs });
  }

  get hasKey(): boolean {
    return !!this.apiKey;
  }

  // ---- public API -------------------------------------------------------

  /** Runs research to completion. Streams when possible so progress can be reported. */
  async research(request: ResearchRequest, options: ResearchOptions = {}): Promise<Run> {
    const idempotencyKey = `mcp_${randomUUID().replace(/-/g, '')}`;
    const body = { ...request, stream: request.mode !== 'reverse' };
    const response = await this.send('POST', '/research', {
      body,
      idempotencyKey,
      accept: 'text/event-stream, application/json',
      signal: options.signal,
      // A stream can legitimately run longer than one ordinary request.
      timeoutMs: Math.max(this.timeoutMs, 180_000),
    });

    let run: Run;
    const type = response.headers.get('content-type') ?? '';
    if (type.includes('text/event-stream') && response.body) {
      run = await this.readStream(response, options);
    } else {
      run = (await this.readJson(response)) as Run;
    }

    if (!isTerminal(run) && options.waitMs !== 0) {
      run = await this.waitForRun(run.id, options);
    }
    return run;
  }

  async verify(request: VerifyRequest, options: CallOptions = {}): Promise<Verification> {
    const response = await this.send('POST', '/verify', { body: request, signal: options.signal });
    return (await this.readJson(response)) as Verification;
  }

  async getRun(id: string, options: CallOptions = {}): Promise<Run> {
    const response = await this.send('GET', `/runs/${encodeURIComponent(id)}`, { signal: options.signal });
    return (await this.readJson(response)) as Run;
  }

  async listRuns(params: { limit?: number; starting_after?: string } = {}, options: CallOptions = {}): Promise<RunList> {
    const query = new URLSearchParams();
    if (params.limit) query.set('limit', String(params.limit));
    if (params.starting_after) query.set('starting_after', params.starting_after);
    const qs = query.toString();
    const response = await this.send('GET', `/runs${qs ? `?${qs}` : ''}`, { signal: options.signal });
    return (await this.readJson(response)) as RunList;
  }

  async wallet(options: CallOptions = {}): Promise<Wallet> {
    const response = await this.send('GET', '/wallet', { signal: options.signal });
    return (await this.readJson(response)) as Wallet;
  }

  async walletEntries(params: { before?: number } = {}, options: CallOptions = {}): Promise<Entries> {
    const qs = params.before ? `?before=${encodeURIComponent(String(params.before))}` : '';
    const response = await this.send('GET', `/wallet/entries${qs}`, { signal: options.signal });
    return (await this.readJson(response)) as Entries;
  }

  async pricing(options: CallOptions = {}): Promise<Record<string, unknown>> {
    const response = await this.send('GET', '/pricing', { signal: options.signal, auth: false });
    return (await this.readJson(response)) as Record<string, unknown>;
  }

  /** Polls a queued run until it finishes or `waitMs` passes; returns the latest state either way. */
  async waitForRun(id: string, options: ResearchOptions = {}): Promise<Run> {
    const deadline = Date.now() + (options.waitMs ?? 300_000);
    let interval = Math.max(500, options.pollMs ?? 2_000);
    let step = 0;
    let run = await this.getRun(id, options);
    while (!isTerminal(run) && Date.now() < deadline) {
      step += 1;
      options.onProgress?.({ stage: run.status, message: queuedMessage(run), step });
      await this.sleep(Math.min(interval, Math.max(0, deadline - Date.now())), options.signal);
      interval = Math.min(interval * 1.5, 10_000);
      run = await this.getRun(id, options);
    }
    return run;
  }

  // ---- transport --------------------------------------------------------

  private async send(
    method: 'GET' | 'POST',
    path: string,
    init: {
      body?: unknown;
      idempotencyKey?: string;
      accept?: string;
      signal?: AbortSignal;
      timeoutMs?: number;
      auth?: boolean;
    },
  ): Promise<Response> {
    const needsAuth = init.auth !== false;
    if (needsAuth && !this.apiKey) {
      throw new ZearchError({
        type: 'configuration_error',
        code: 'missing_api_key',
        message:
          'No Zearch API key is configured. Set ZEARCH_API_KEY to a key from Account → API keys (https://zearch.computer/developers).',
      });
    }
    const headers: Record<string, string> = {
      Accept: init.accept ?? 'application/json',
      'User-Agent': `zearch-mcp/${VERSION} (+https://github.com/zearchcomputer/zearch-mcp)`,
    };
    if (needsAuth) headers.Authorization = `Bearer ${this.apiKey}`;
    if (init.body !== undefined) headers['Content-Type'] = 'application/json';
    if (init.idempotencyKey) headers['Idempotency-Key'] = init.idempotencyKey;
    const payload = init.body === undefined ? undefined : JSON.stringify(init.body);

    let attempt = 0;
    while (true) {
      const timeout = AbortSignal.timeout(init.timeoutMs ?? this.timeoutMs);
      const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.apiUrl}${path}`, { method, headers, body: payload, signal });
      } catch (cause) {
        if (init.signal?.aborted) throw init.signal.reason ?? cause;
        const timedOut = timeout.aborted;
        const err = new ZearchError({
          type: timedOut ? 'timeout' : 'network_error',
          code: timedOut ? 'timeout' : 'network_error',
          message: timedOut
            ? `No response from ${this.apiUrl} within ${Math.round((init.timeoutMs ?? this.timeoutMs) / 1000)} s.`
            : `Request to ${this.apiUrl} failed: ${(cause as Error)?.message ?? String(cause)}`,
        });
        // A POST is only safe to retry when it carries an idempotency key.
        if (attempt < this.maxRetries && (method === 'GET' || init.idempotencyKey) && !timedOut) {
          await this.backoff(attempt++, undefined, init.signal);
          continue;
        }
        throw err;
      }

      if (response.ok) return response;

      const body = await response.json().catch(() => null);
      const err = errorFromResponse(response.status, body, response.headers);
      const canRetry = method === 'GET' || !!init.idempotencyKey;
      if (err.retryable && canRetry && attempt < this.maxRetries && (err.retryAfterMs ?? 0) <= 30_000) {
        await this.backoff(attempt++, err.retryAfterMs, init.signal);
        continue;
      }
      throw err;
    }
  }

  private async backoff(attempt: number, retryAfterMs: number | undefined, signal?: AbortSignal): Promise<void> {
    const base = retryAfterMs ?? Math.min(8_000, 500 * 2 ** attempt);
    const jitter = retryAfterMs ? 0 : Math.random() * 250;
    await this.sleep(base + jitter, signal);
  }

  private async readJson(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      throw new ZearchError({
        type: 'api_error',
        code: 'invalid_response',
        message: 'Zearch returned a response that is not JSON.',
        status: response.status,
        requestId: response.headers.get('x-request-id') ?? undefined,
      });
    }
  }

  private async readStream(response: Response, options: ResearchOptions): Promise<Run> {
    const requestId = response.headers.get('x-request-id') ?? undefined;
    let step = 0;
    let runId: string | undefined;
    let complete: Run | undefined;
    for await (const event of parseSse(response.body!, options.signal)) {
      let data: Record<string, unknown> = {};
      try {
        data = event.data ? (JSON.parse(event.data) as Record<string, unknown>) : {};
      } catch {
        continue;
      }
      switch (event.event) {
        case 'start':
          if (typeof data.id === 'string') runId = data.id;
          options.onProgress?.({ stage: 'start', message: 'Starting', step: ++step });
          break;
        case 'status':
          options.onProgress?.({ stage: 'status', message: String(data.text ?? 'Working'), step: ++step });
          break;
        case 'sources': {
          const sources = (data.sources as Source[] | undefined) ?? [];
          options.onSources?.(sources);
          options.onProgress?.({
            stage: 'sources',
            message: `Selected ${sources.length} source${sources.length === 1 ? '' : 's'}`,
            step: ++step,
          });
          break;
        }
        case 'complete':
          complete = data as Run;
          break;
        case 'error':
          throw new ZearchError({
            type: 'api_error',
            code: String(data.code ?? 'run_failed'),
            message: String(data.error ?? data.message ?? 'The run failed.'),
            requestId,
          });
        default:
          break;
      }
    }
    if (complete) return complete;
    // The stream ended early (network drop, proxy timeout). The run may still finish server-side.
    if (runId) return this.getRun(runId, options);
    throw new ZearchError({
      type: 'network_error',
      code: 'stream_ended',
      message: 'The research stream ended before the answer was complete.',
      requestId,
    });
  }
}

function queuedMessage(run: Run): string {
  if (run.status === 'pending') return run.mode === 'reverse' ? 'Queued for analysis' : 'Queued';
  if (run.status === 'streaming') return 'Working';
  return run.status;
}
