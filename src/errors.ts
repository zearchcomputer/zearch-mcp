/** Errors from the Zearch API, and the plain-language messages tools show for them. */

export type ZearchErrorType =
  | 'invalid_request_error'
  | 'authentication_error'
  | 'insufficient_credits'
  | 'permission_error'
  | 'not_found_error'
  | 'conflict_error'
  | 'rate_limit_error'
  | 'api_error'
  | 'service_unavailable'
  | 'network_error'
  | 'timeout'
  | 'configuration_error';

export class ZearchError extends Error {
  readonly type: ZearchErrorType;
  readonly code: string;
  readonly status: number;
  readonly requestId?: string;
  readonly param?: string;
  readonly retryAfterMs?: number;

  constructor(init: {
    type: ZearchErrorType;
    code: string;
    message: string;
    status?: number;
    requestId?: string;
    param?: string;
    retryAfterMs?: number;
  }) {
    super(init.message);
    this.name = 'ZearchError';
    this.type = init.type;
    this.code = init.code;
    this.status = init.status ?? 0;
    this.requestId = init.requestId;
    this.param = init.param;
    this.retryAfterMs = init.retryAfterMs;
  }

  /** Worth retrying with the same idempotency key. */
  get retryable(): boolean {
    if (this.type === 'network_error') return true;
    if (this.status === 429) return this.code === 'rate_limited'; // daily_limit won't clear in seconds
    if (this.status === 503) return this.code !== 'api_disabled';
    return this.status === 500 || this.status === 502 || this.status === 504;
  }
}

const TYPE_BY_STATUS: Record<number, ZearchErrorType> = {
  400: 'invalid_request_error',
  401: 'authentication_error',
  402: 'insufficient_credits',
  403: 'permission_error',
  404: 'not_found_error',
  409: 'conflict_error',
  413: 'invalid_request_error',
  415: 'invalid_request_error',
  422: 'invalid_request_error',
  429: 'rate_limit_error',
  503: 'service_unavailable',
};

export function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

/** Build an error from a non-2xx response body (the documented `{error: {…}}` envelope, or anything else). */
export function errorFromResponse(status: number, body: unknown, headers: Headers): ZearchError {
  const envelope = (body as { error?: Record<string, unknown> } | null)?.error;
  const requestId = (envelope?.request_id as string | undefined) ?? headers.get('x-request-id') ?? undefined;
  return new ZearchError({
    type: (envelope?.type as ZearchErrorType | undefined) ?? TYPE_BY_STATUS[status] ?? 'api_error',
    code: (envelope?.code as string | undefined) ?? `http_${status}`,
    message: (envelope?.message as string | undefined) ?? `Zearch returned HTTP ${status}.`,
    status,
    requestId,
    param: envelope?.param as string | undefined,
    retryAfterMs: parseRetryAfter(headers.get('retry-after')),
  });
}

const PRICING_URL = 'https://zearch.computer/pricing';
const KEYS_URL = 'https://zearch.computer/developers';

/** The message a person (or a model) should see. Plain about what happened and what to do next. */
export function describeError(err: unknown): string {
  if (!(err instanceof ZearchError)) {
    return `Zearch couldn't complete this request: ${err instanceof Error ? err.message : String(err)}`;
  }
  const ref = err.requestId ? ` (request ${err.requestId})` : '';
  switch (err.type) {
    case 'configuration_error':
      return err.message;
    case 'authentication_error':
      return `Zearch didn't accept the API key${ref}. Create a key in Account → API keys (${KEYS_URL}) and set ZEARCH_API_KEY, or send it as a Bearer token.`;
    case 'insufficient_credits':
      return err.code === 'member_cap_reached'
        ? `${err.message} Ask your team admin to raise your monthly limit${ref}.`
        : `You're out of credits for this. ${err.message} Choose a plan or a top-up at ${PRICING_URL}${ref}.`;
    case 'rate_limit_error': {
      const wait = err.retryAfterMs ? ` Try again in about ${Math.ceil(err.retryAfterMs / 1000)} seconds.` : '';
      return `${err.message}${wait}${ref}`;
    }
    case 'not_found_error':
      return `${err.message}${ref}`;
    case 'service_unavailable':
      return err.code === 'api_disabled'
        ? `The Zearch API isn't switched on for this deployment yet${ref}.`
        : `Zearch is temporarily unavailable. ${err.message} Try again shortly${ref}.`;
    case 'network_error':
      return `Couldn't reach Zearch. ${err.message}`;
    case 'timeout':
      return `Zearch took too long to answer. ${err.message}`;
    case 'invalid_request_error':
      return `${err.message}${err.param ? ` (field: ${err.param})` : ''}${ref}`;
    default:
      return `Zearch couldn't complete this request: ${err.message}${ref}`;
  }
}
