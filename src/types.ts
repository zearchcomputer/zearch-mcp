/**
 * Zearch API shapes (docs/openapi.yaml in zearchcomputer/zearch), as Zod schemas.
 * They describe tool output, so they are permissive: unknown fields pass through,
 * and anything the API may leave out is optional or nullable.
 */
import * as z from 'zod/v4';

export const MODES = ['standard', 'deep', 'compare', 'scrape', 'crawl', 'reverse'] as const;
export type Mode = (typeof MODES)[number];

export const SourceSchema = z.looseObject({
  n: z.number().int().describe('Citation number used in the answer, as [n].'),
  url: z.string().nullish(),
  title: z.string().nullish(),
  domain: z.string().nullish(),
  excerpt: z.string().nullish().describe('The passage Jev inspected.'),
  evidence_span: z.array(z.number()).nullish().describe('Character offsets of the excerpt in the capture.'),
  published_date: z.string().nullish(),
  captured_at: z.number().nullish(),
  capture_id: z.string().nullish(),
  authority: z.string().nullish().describe('official, publisher, reference or low_signal.'),
});
export type Source = z.infer<typeof SourceSchema>;

export const RunSchema = z.looseObject({
  id: z.string(),
  object: z.string().optional(),
  status: z.string().describe('pending, streaming, complete, error, interrupted or redacted.'),
  mode: z.string().optional(),
  query: z.string().optional(),
  parent_id: z.string().nullish(),
  answer: z.string().nullish().describe('Markdown with [n] citations.'),
  answer_type: z
    .string()
    .nullish()
    .describe('verified: every paragraph passed Jev. excerpt: the selected source passage, because no draft could be supported.'),
  verification: z
    .looseObject({
      gate: z.string().optional(),
      paragraph_support: z.array(z.number()).nullish(),
      paragraph_attribution: z.array(z.number().nullable()).nullish(),
      model: z.string().optional(),
    })
    .nullish(),
  sources: z.array(SourceSchema).optional(),
  followups: z.array(z.string()).optional(),
  error: z.string().nullish(),
  timing_ms: z.number().nullish(),
  created: z.number().optional(),
  updated: z.number().optional(),
});
export type Run = z.infer<typeof RunSchema>;

export const RunListSchema = z.looseObject({
  object: z.string().optional(),
  data: z.array(RunSchema),
  has_more: z.boolean().optional(),
});
export type RunList = z.infer<typeof RunListSchema>;

export const VerificationSchema = z.looseObject({
  object: z.string().optional(),
  passed: z.boolean().describe('True when every paragraph met the support threshold.'),
  threshold: z.number().optional(),
  paragraphs: z.array(
    z.looseObject({
      index: z.number().int(),
      text: z.string(),
      support: z.number().describe('Probability, 0 to 1, that the cited sources support this paragraph.'),
      attribution: z.number().nullish().describe('Probability that the citation points at the right source.'),
      passed: z.boolean(),
    }),
  ),
  model: z.string().nullish(),
});
export type Verification = z.infer<typeof VerificationSchema>;

export const WalletSchema = z.looseObject({
  object: z.string().optional(),
  wallet: z.string().optional().describe('personal or organization.'),
  plan: z.string().optional(),
  available: z.number().describe('Credits available now.'),
  held: z.number().optional().describe('Credits reserved by runs still in progress.'),
  member_cap: z.number().nullish(),
  lots: z
    .array(
      z.looseObject({
        source: z.string().optional(),
        remaining: z.number().optional(),
        granted: z.number().optional(),
        expires: z.number().optional(),
      }),
    )
    .optional(),
});
export type Wallet = z.infer<typeof WalletSchema>;

export const EntriesSchema = z.looseObject({
  object: z.string().optional(),
  entries: z.array(
    z.looseObject({
      kind: z.string().optional(),
      reference: z.string().optional(),
      credits: z.number().optional(),
      member: z.string().nullish(),
      at: z.number().optional(),
    }),
  ),
  next_before: z.number().nullish(),
});
export type Entries = z.infer<typeof EntriesSchema>;

export interface ResearchRequest {
  query: string;
  mode?: Mode;
  url?: string;
  parent_id?: string;
  use_notes?: boolean;
}

export interface VerifyRequest {
  text: string;
  sources: { text: string; title?: string; url?: string }[];
  question?: string;
}

/** Live progress while a run streams or waits in the queue. */
export interface ResearchProgress {
  stage: string;
  message: string;
  step: number;
}
