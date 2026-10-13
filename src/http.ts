/**
 * Streamable HTTP serving for remote and shared deployments (for example mcp.zearch.computer).
 *
 * Auth model: each caller sends their own Zearch API key as `Authorization: Bearer zk_live_…`,
 * and every request is made with that key. The server never stores keys. A key from
 * ZEARCH_API_KEY is used as a fallback only when the server is bound to loopback, so a
 * public deployment can never spend the operator's credits on someone else's behalf.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import {
  createMcpHandler,
  hostHeaderValidationResponse,
  localhostAllowedHostnames,
  localhostAllowedOrigins,
  originValidationResponse,
  type AuthInfo,
} from '@modelcontextprotocol/server';
import { ZearchClient } from './client.js';
import { VERSION, looksLikeApiKey, type ZearchConfig } from './config.js';
import { createZearchServer } from './server.js';

export interface HttpOptions {
  host: string;
  port: number;
  /** Extra hostnames accepted in the Host header (needed when bound to a public interface). */
  allowedHosts?: string[];
  path?: string;
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
  res.end(payload);
}

function toRequest(req: IncomingMessage, signal: AbortSignal): Request {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) for (const v of value) headers.append(name, v);
    else if (value !== undefined) headers.set(name, value);
  }
  const method = req.method ?? 'GET';
  const hasBody = method !== 'GET' && method !== 'HEAD';
  return new Request(url, {
    method,
    headers,
    body: hasBody ? (Readable.toWeb(req) as ReadableStream<Uint8Array>) : undefined,
    signal,
    // Required by Node's fetch for streaming request bodies.
    duplex: 'half',
  } as RequestInit);
}

async function writeResponse(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  res.writeHead(response.status, headers);
  if (!response.body) return void res.end();
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    if (!res.write(chunk)) await new Promise((resolve) => res.once('drain', resolve));
  }
  res.end();
}

function bearer(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  const match = header?.match(/^Bearer\s+(\S+)\s*$/i);
  return match?.[1];
}

export function startHttpServer(config: ZearchConfig, options: HttpOptions): Promise<Server> {
  const path = options.path ?? '/mcp';
  const loopback = LOOPBACK.has(options.host);
  const allowedHosts = [...(loopback ? localhostAllowedHostnames() : []), ...(options.allowedHosts ?? [])];

  const handler = createMcpHandler(({ authInfo }) => {
    const client = ZearchClient.fromConfig(config, authInfo?.token);
    return createZearchServer({ config, client });
  });

  const server = createServer(async (req, res) => {
    const controller = new AbortController();
    res.on('close', () => controller.abort());
    try {
      const url = new URL(req.url ?? '/', 'http://local');
      if (url.pathname === '/healthz' && req.method === 'GET') {
        return json(res, 200, { ok: true, name: 'zearch-mcp', version: VERSION });
      }
      if (url.pathname !== path) return json(res, 404, { error: 'Not found. The MCP endpoint is ' + path });

      const request = toRequest(req, controller.signal);
      if (allowedHosts.length) {
        const rejected = hostHeaderValidationResponse(request, allowedHosts);
        if (rejected) return void (await writeResponse(res, rejected));
      }
      if (loopback) {
        const rejected = originValidationResponse(request, localhostAllowedOrigins());
        if (rejected) return void (await writeResponse(res, rejected));
      }

      const token = bearer(req);
      let key: string | undefined;
      if (token !== undefined) {
        if (!looksLikeApiKey(token)) {
          return json(res, 401, { error: 'invalid_token', message: 'Send a Zearch API key (zk_live_…) as the Bearer token.' }, {
            'WWW-Authenticate': 'Bearer realm="zearch", error="invalid_token"',
          });
        }
        key = token;
      } else if (loopback && config.apiKey) {
        key = config.apiKey;
      }
      // Requests without a key still work for key-free calls (tools/list, get_pricing);
      // tools that need one return a clear error. Authenticated calls get the caller's key.
      const authInfo: AuthInfo | undefined = key ? { token: key, clientId: 'zearch-api-key', scopes: [] } : undefined;
      const response = await handler.fetch(request, authInfo ? { authInfo } : undefined);
      await writeResponse(res, response);
    } catch (err) {
      if (!res.headersSent) json(res, 500, { error: 'internal_error' });
      else res.destroy(err as Error);
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => {
      server.off('error', reject);
      const close = server.close.bind(server);
      server.close = ((cb?: (err?: Error) => void) => {
        void handler.close();
        return close(cb);
      }) as typeof server.close;
      resolve(server);
    });
  });
}
