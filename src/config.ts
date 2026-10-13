/** Runtime configuration, read from the environment. Nothing here is ever logged. */

export const VERSION = '0.1.0';
export const DEFAULT_API_URL = 'https://zearch.computer/v1';

export interface ZearchConfig {
  /** Zearch API key (`zk_live_…`). Optional in HTTP mode, where each caller sends their own. */
  apiKey?: string;
  /** Base URL of the Zearch API, ending in `/v1`. */
  apiUrl: string;
  /** Per-request timeout for API calls, in milliseconds. */
  timeoutMs: number;
  /** How long `research` waits for a queued Reverse engineer run before handing back its id. */
  reverseWaitMs: number;
  /** Whether tools advertise the inline answer view (MCP Apps). */
  ui: boolean;
}

function num(value: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!value || !Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

export function normalizeApiUrl(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('ZEARCH_API_URL must use https (http is allowed only for localhost).');
  }
  let path = url.pathname.replace(/\/+$/, '');
  if (!path.endsWith('/v1')) path += '/v1';
  url.pathname = path;
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ZearchConfig {
  const apiKey = env.ZEARCH_API_KEY?.trim() || undefined;
  return {
    apiKey,
    apiUrl: normalizeApiUrl(env.ZEARCH_API_URL?.trim() || DEFAULT_API_URL),
    timeoutMs: num(env.ZEARCH_TIMEOUT_MS, 120_000, 5_000, 600_000),
    reverseWaitMs: num(env.ZEARCH_REVERSE_WAIT_MS, 300_000, 0, 1_800_000),
    ui: !['0', 'false', 'off'].includes((env.ZEARCH_UI ?? '').toLowerCase()),
  };
}

/** API keys look like `zk_live_…` or `zk_test_…`. A cheap shape check before a network round trip. */
export function looksLikeApiKey(value: string | undefined): value is string {
  return !!value && /^zk_(live|test)_[A-Za-z0-9_-]{8,200}$/.test(value);
}
