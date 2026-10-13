/**
 * The Zearch MCP server: tools, resources, prompts and the inline answer view.
 * `createZearchServer` builds one McpServer instance; transports (stdio, HTTP) call it
 * once per connection or request with the client that should be used.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { McpServer, ResourceTemplate, type CallToolResult, type ServerContext } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { ZearchClient } from './client.js';
import { VERSION, type ZearchConfig } from './config.js';
import { ZearchError, describeError } from './errors.js';
import { formatRun, formatRunList, formatVerification, formatWallet } from './format.js';
import {
  EntriesSchema,
  MODES,
  RunListSchema,
  RunSchema,
  VerificationSchema,
  WalletSchema,
  type Run,
} from './types.js';

export { ZearchClient } from './client.js';
export { loadConfig, type ZearchConfig } from './config.js';
export { ZearchError, describeError } from './errors.js';

export const UI_URI = 'ui://zearch/answer.html';
/** MIME type for MCP Apps views (io.modelcontextprotocol/ui extension). */
export const UI_MIME_TYPE = 'text/html;profile=mcp-app';

const RUN_ID = z.string().regex(/^[a-f0-9]{32}$/, 'A run id is 32 lowercase hex characters.');

const INSTRUCTIONS = `Zearch is a research engine that checks every paragraph against its sources before returning it.

Use \`research\` for questions about the world that need current or cited facts. Each answer comes with numbered sources, the exact passage Zearch's evidence model (Jev) read, and a per-paragraph support score. When Zearch can't support an answer it returns the best source passage instead (answer_type "excerpt"); present that as a quote, not as a conclusion.

Use \`verify\` to check text you or another model wrote against sources you already have, before showing it to someone.

When you pass on a Zearch answer, keep the [n] citations next to the claims they support and list the sources. Don't add claims the sources don't make. Research and verification spend the user's Zearch credits; errors are free.`;

let cachedUi: string | undefined;
function answerViewHtml(): string {
  cachedUi ??= readFileSync(fileURLToPath(new URL('./ui/answer.html', import.meta.url)), 'utf8');
  return cachedUi;
}

export interface CreateServerOptions {
  config: ZearchConfig;
  /** The client this instance should use (one per API key). */
  client: ZearchClient;
}

function errorResult(err: unknown): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: describeError(err) }] };
}

function progressReporter(ctx: ServerContext) {
  const token = ctx.mcpReq._meta?.progressToken;
  if (token === undefined) return undefined;
  return (progress: number, message: string, total?: number) => {
    void ctx.mcpReq
      .notify({ method: 'notifications/progress', params: { progressToken: token, progress, total, message } })
      .catch(() => {});
  };
}

function runResult(run: Run): CallToolResult {
  const failed = run.status === 'error' || run.status === 'interrupted';
  return {
    content: [{ type: 'text', text: formatRun(run) }],
    structuredContent: run as Record<string, unknown>,
    ...(failed ? { isError: true } : {}),
  };
}

export function createZearchServer({ config, client }: CreateServerOptions): McpServer {
  const server = new McpServer(
    {
      name: 'zearch',
      title: 'Zearch',
      version: VERSION,
      websiteUrl: 'https://zearch.computer',
    } as { name: string; version: string; title?: string },
    { instructions: INSTRUCTIONS },
  );

  const uiMeta = config.ui ? { ui: { resourceUri: UI_URI }, 'ui/resourceUri': UI_URI } : undefined;

  // ---- tools ------------------------------------------------------------

  server.registerTool(
    'research',
    {
      title: 'Research with checked answers',
      description: `Ask Zearch a question. Zearch searches the web (or reads the page or site you give it), Jev selects the passages that answer it, a writer drafts from those passages only, and Jev checks every paragraph against its cited source before the answer is returned. Unsupported paragraphs are cut; if nothing survives you get the selected source passage (answer_type "excerpt").

Modes and credits: standard (1, a direct answer in seconds), deep (5, a cited report from up to 8 sources), compare (2, a side-by-side comparison), scrape (1, what one public HTTPS page says; needs url), crawl (3, up to five pages of one site; needs url), reverse (10, static analysis of how an app, repo or site works; needs url, runs on a queue and can take minutes). A follow-up with parent_id that needs no new search costs 0.3. Errors are free.

Returns the answer as Markdown with [n] citations, the sources with the exact excerpt Jev read, per-paragraph support scores, and suggested follow-ups.`,
      inputSchema: z.object({
        query: z.string().min(1).max(2000).describe('The question, in plain language.'),
        mode: z.enum(MODES).default('standard').describe('How much research to do. See the tool description for costs.'),
        url: z
          .url({ protocol: /^https$/ })
          .optional()
          .describe('Public HTTPS URL. Required for scrape, crawl and reverse; ignored otherwise.'),
        parent_id: RUN_ID.optional().describe('Id of a previous run, to ask a follow-up in the same conversation.'),
        use_notes: z
          .boolean()
          .default(false)
          .describe("Also use the account's private Zearch notes and documents as evidence."),
      }),
      outputSchema: RunSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      ...(uiMeta ? { _meta: uiMeta } : {}),
    },
    async (args, ctx) => {
      if (['scrape', 'crawl', 'reverse'].includes(args.mode) && !args.url) {
        return errorResult(
          new ZearchError({ type: 'invalid_request_error', code: 'url_required', message: `Mode "${args.mode}" needs a url.`, param: 'url' }),
        );
      }
      const report = progressReporter(ctx);
      try {
        const run = await client.research(
          {
            query: args.query,
            mode: args.mode,
            url: ['scrape', 'crawl', 'reverse'].includes(args.mode) ? args.url : undefined,
            parent_id: args.parent_id,
            use_notes: args.use_notes || undefined,
          },
          {
            signal: ctx.mcpReq.signal,
            waitMs: args.mode === 'reverse' ? config.reverseWaitMs : undefined,
            onProgress: report ? (p) => report(p.step, p.message) : undefined,
          },
        );
        return runResult(run);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'verify',
    {
      title: 'Verify text against sources',
      description: `Check text against the sources it cites, paragraph by paragraph, with Jev (the same check Zearch runs on its own answers). Cite sources inline as [1], [2]… in the order you list them. Use it to gate output from your own model before a person sees it.

Limits: text up to 8,000 characters; 1 to 8 sources of up to 20,000 characters each. Costs 1 credit, charged only when the check completes. Returns pass/fail per paragraph with support and attribution probabilities.`,
      inputSchema: z.object({
        text: z.string().min(1).max(8000).describe('Markdown to check. Every paragraph should cite at least one source as [n].'),
        sources: z
          .array(
            z.object({
              text: z.string().min(1).max(20000).describe('The source text the citations refer to.'),
              title: z.string().max(200).optional(),
              url: z.string().max(500).optional(),
            }),
          )
          .min(1)
          .max(8)
          .describe('Sources in citation order: the first is [1].'),
        question: z.string().max(2000).optional().describe('The question the text answers, if any. Improves the check.'),
      }),
      outputSchema: VerificationSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      ...(uiMeta ? { _meta: uiMeta } : {}),
    },
    async (args, ctx) => {
      const cited = [...args.text.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]));
      if (!cited.length) {
        return errorResult(
          new ZearchError({
            type: 'invalid_request_error',
            code: 'missing_citations',
            message: 'Cite sources inline as [1], [2]… matching the order of sources.',
            param: 'text',
          }),
        );
      }
      const outOfRange = [...new Set(cited.filter((n) => n < 1 || n > args.sources.length))];
      if (outOfRange.length) {
        return errorResult(
          new ZearchError({
            type: 'invalid_request_error',
            code: 'citation_out_of_range',
            message: `The text cites ${outOfRange.map((n) => `[${n}]`).join(', ')} but only ${args.sources.length} source${args.sources.length === 1 ? ' was' : 's were'} given.`,
            param: 'text',
          }),
        );
      }
      try {
        const result = await client.verify(args, { signal: ctx.mcpReq.signal });
        return {
          content: [{ type: 'text', text: formatVerification(result) }],
          structuredContent: result as Record<string, unknown>,
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'get_run',
    {
      title: 'Get a research run',
      description:
        'Fetch one of your Zearch runs by id: its answer, sources, verification and status. Use it to check on a queued Reverse engineer run, or to reopen an earlier answer. Free.',
      inputSchema: z.object({ id: RUN_ID.describe('The run id returned by research or list_runs.') }),
      outputSchema: RunSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      ...(uiMeta ? { _meta: uiMeta } : {}),
    },
    async ({ id }, ctx) => {
      try {
        return runResult(await client.getRun(id, { signal: ctx.mcpReq.signal }));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'list_runs',
    {
      title: 'List research runs',
      description:
        'List your recent Zearch runs, newest first. The app and the API share one history. Free. Page with starting_after.',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(100).default(20),
        starting_after: RUN_ID.optional().describe('Run id from the previous page.'),
      }),
      outputSchema: RunListSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args, ctx) => {
      try {
        const list = await client.listRuns(args, { signal: ctx.mcpReq.signal });
        return { content: [{ type: 'text', text: formatRunList(list) }], structuredContent: list as Record<string, unknown> };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'get_wallet',
    {
      title: 'Credit balance',
      description:
        "Show the Zearch credit balance this key spends from: available and held credits, plan, credit lots and when they expire. Optionally include recent ledger entries. Free.",
      inputSchema: z.object({
        include_entries: z.boolean().default(false).describe('Also return recent ledger entries.'),
        before: z.number().int().optional().describe('next_before cursor from a previous call, for older entries.'),
      }),
      outputSchema: z.object({ wallet: WalletSchema, entries: EntriesSchema.optional() }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ include_entries, before }, ctx) => {
      try {
        const [wallet, entries] = await Promise.all([
          client.wallet({ signal: ctx.mcpReq.signal }),
          include_entries ? client.walletEntries({ before }, { signal: ctx.mcpReq.signal }) : Promise.resolve(undefined),
        ]);
        let text = formatWallet(wallet);
        if (entries?.entries.length) {
          text += '\n\nRecent entries:\n' + entries.entries
            .map((e) => `- ${e.at ? new Date(e.at * 1000).toISOString().slice(0, 16).replace('T', ' ') : ''} ${e.kind ?? ''} ${e.credits ?? ''} ${e.reference ?? ''}`.trim())
            .join('\n');
        }
        return { content: [{ type: 'text', text }], structuredContent: entries ? { wallet, entries } : { wallet } };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'get_pricing',
    {
      title: 'Zearch pricing',
      description: 'The public Zearch price list: credits per request type, plans and top-ups. Free; no API key needed.',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (ctx) => {
      try {
        const pricing = await client.pricing({ signal: ctx.mcpReq.signal });
        return { content: [{ type: 'text', text: JSON.stringify(pricing, null, 2) }], structuredContent: pricing };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // ---- resources --------------------------------------------------------

  server.registerResource(
    'run',
    new ResourceTemplate('zearch://runs/{id}', {
      list: async (ctx) => {
        if (!client.hasKey) return { resources: [] };
        try {
          const list = await client.listRuns({ limit: 20 }, { signal: ctx.mcpReq.signal });
          return {
            resources: list.data.map((r) => ({
              uri: `zearch://runs/${r.id}`,
              name: r.id,
              title: (r.query ?? r.id).slice(0, 120),
              mimeType: 'text/markdown',
            })),
          };
        } catch {
          return { resources: [] };
        }
      },
    }),
    {
      title: 'Zearch run',
      description: 'A research run as Markdown: the checked answer, its sources and the passages Jev read.',
      mimeType: 'text/markdown',
    },
    async (uri, variables, ctx) => {
      const id = String(Array.isArray(variables.id) ? variables.id[0] : variables.id);
      if (!/^[a-f0-9]{32}$/.test(id)) throw new Error('A run id is 32 lowercase hex characters.');
      const run = await client.getRun(id, { signal: ctx.mcpReq.signal });
      return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: formatRun(run) }] };
    },
  );

  server.registerResource(
    'pricing',
    'zearch://pricing',
    { title: 'Zearch pricing', description: 'Credits per request type, plans and top-ups.', mimeType: 'application/json' },
    async (uri, ctx) => {
      const pricing = await client.pricing({ signal: ctx.mcpReq.signal });
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(pricing, null, 2) }] };
    },
  );

  if (config.ui) {
    server.registerResource(
      'answer-view',
      UI_URI,
      {
        title: 'Zearch answer view',
        description: 'Shows a checked answer with its citations and source passages.',
        mimeType: UI_MIME_TYPE,
        _meta: { ui: { prefersBorder: true } },
      },
      async (uri) => ({
        contents: [{ uri: uri.href, mimeType: UI_MIME_TYPE, text: answerViewHtml(), _meta: { ui: { prefersBorder: true } } }],
      }),
    );
  }

  // ---- prompts ----------------------------------------------------------

  server.registerPrompt(
    'research_brief',
    {
      title: 'Research brief',
      description: 'A cited brief on a topic, built from Zearch deep research.',
      argsSchema: z.object({
        topic: z.string().describe('What the brief is about.'),
        audience: z.string().optional().describe('Who will read it, for example "a board" or "engineers".'),
      }),
    },
    ({ topic, audience }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Write a research brief on: ${topic}${audience ? `\nAudience: ${audience}` : ''}

1. Call the Zearch \`research\` tool with mode "deep" on the topic. If it leaves an important question open, ask one or two follow-ups with parent_id set to that run's id.
2. Write the brief only from what those answers and their sources support. Keep the [n] citations next to each claim and end with the source list.
3. Where Zearch returned an excerpt instead of a checked answer, or sources disagree, say so plainly. Don't fill gaps from memory.`,
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    'fact_check',
    {
      title: 'Fact-check a draft',
      description: 'Check a draft against sources with Zearch and report what is and isn’t supported.',
      argsSchema: z.object({ draft: z.string().describe('The text to check.') }),
    },
    ({ draft }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Fact-check this draft:

"""
${draft}
"""

1. List the factual claims it makes.
2. For claims that need evidence, call the Zearch \`research\` tool to find sources (standard mode is usually enough).
3. Rewrite the draft so each claim cites the source text you found as [n], then call \`verify\` with that text and those sources.
4. Report which paragraphs passed, which failed and why, and suggest a corrected version that keeps only supported claims.`,
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    'compare',
    {
      title: 'Compare two options',
      description: 'A side-by-side comparison with a citation in every cell.',
      argsSchema: z.object({
        a: z.string().describe('The first option.'),
        b: z.string().describe('The second option.'),
        criteria: z.string().optional().describe('What matters, for example "price, battery life, repairability".'),
      }),
    },
    ({ a, b, criteria }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Compare ${a} and ${b}${criteria ? ` on ${criteria}` : ''}. Call the Zearch \`research\` tool with mode "compare", then present the result as a table that keeps a citation in every cell, followed by the sources. Mark any cell the sources don't cover as "not found" rather than guessing.`,
          },
        },
      ],
    }),
  );

  return server;
}
