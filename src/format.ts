/**
 * Plain-text renderings of runs and verifications for the tool `content` channel.
 * The model reads these; the structured result and the answer view carry the same data.
 * Copy follows Zearch's voice: say what was checked, say what wasn't, no hype.
 */
import type { Run, RunList, Source, Verification, Wallet } from './types.js';

const pct = (p: number | null | undefined) => (typeof p === 'number' ? `${Math.round(p * 100)}%` : 'n/a');

function sourceLine(s: Source): string {
  const title = s.title?.trim() || s.domain || s.url || 'Untitled source';
  const where = [s.domain, s.authority === 'official' ? 'official source' : null, s.published_date ? `published ${s.published_date}` : null]
    .filter(Boolean)
    .join(' · ');
  return `[${s.n}] ${title}${where ? ` (${where})` : ''}${s.url ? `\n    ${s.url}` : ''}`;
}

function quote(text: string, max = 600): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  const cut = clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
  return `    > ${cut}`;
}

export function verificationSummary(run: Run): string | undefined {
  const support = run.verification?.paragraph_support ?? [];
  if (run.answer_type === 'verified' && support.length) {
    const min = Math.min(...support);
    return `Checked: all ${support.length} paragraph${support.length === 1 ? '' : 's'} supported by the cited sources (lowest support ${pct(min)}, Jev ${run.verification?.model ?? ''}).`.replace(' )', ')');
  }
  if (run.answer_type === 'excerpt') {
    return "Zearch couldn't verify an answer. Here's what the best source says.";
  }
  return undefined;
}

export function formatRun(run: Run, options: { includeExcerpts?: boolean } = {}): string {
  const lines: string[] = [];
  const mode = run.mode && run.mode !== 'standard' ? ` · ${run.mode}` : '';
  lines.push(`Zearch run ${run.id}${mode} · ${run.status}`);
  if (run.query) lines.push(`Question: ${run.query}`);

  if (run.status === 'pending' || run.status === 'streaming') {
    lines.push('', 'Still working. Call get_run with this id to check again.');
    return lines.join('\n');
  }
  if (run.status === 'error' || run.status === 'interrupted') {
    lines.push('', `This run didn't finish${run.error ? `: ${run.error}` : '.'} Errors aren't charged.`);
    return lines.join('\n');
  }
  if (run.status === 'redacted') {
    lines.push('', 'This answer was redacted because a source or note it used was deleted.');
    return lines.join('\n');
  }

  const summary = verificationSummary(run);
  if (summary) lines.push('', summary);
  if (run.answer) lines.push('', run.answer.trim());

  const sources = run.sources ?? [];
  if (sources.length) {
    lines.push('', 'Sources:');
    for (const s of sources) {
      lines.push(sourceLine(s));
      if (options.includeExcerpts !== false && s.excerpt) lines.push(quote(s.excerpt));
    }
  }
  if (run.followups?.length) {
    lines.push('', 'Possible follow-ups (pass parent_id to keep the conversation):');
    for (const f of run.followups) lines.push(`- ${f}`);
  }
  lines.push(
    '',
    'When you relay this answer, keep the [n] citations next to the claims they support and list the sources. Do not add claims the sources do not support.',
  );
  return lines.join('\n');
}

export function formatVerification(v: Verification): string {
  const failed = v.paragraphs.filter((p) => !p.passed);
  const head = v.passed
    ? `Passed: all ${v.paragraphs.length} paragraph${v.paragraphs.length === 1 ? '' : 's'} supported by the cited sources.`
    : `${failed.length} of ${v.paragraphs.length} paragraph${v.paragraphs.length === 1 ? '' : 's'} not supported by the cited sources.`;
  const lines = [head, `Threshold ${pct(v.threshold)}${v.model ? ` · Jev ${v.model}` : ''}`, ''];
  for (const p of v.paragraphs) {
    const excerpt = p.text.replace(/\s+/g, ' ').trim();
    lines.push(
      `${p.passed ? 'PASS' : 'FAIL'} ¶${p.index + 1} · support ${pct(p.support)} · attribution ${pct(p.attribution)}`,
      `    ${excerpt.length > 240 ? `${excerpt.slice(0, 239)}…` : excerpt}`,
    );
  }
  if (failed.length) {
    lines.push('', 'Revise or remove the failing paragraphs, or cite a source that supports them, then verify again.');
  }
  return lines.join('\n');
}

export function formatRunList(list: RunList): string {
  if (!list.data.length) return 'No runs yet.';
  const lines = list.data.map((r) => {
    const when = r.created ? new Date(r.created * 1000).toISOString().slice(0, 16).replace('T', ' ') : '';
    const kind = r.answer_type === 'verified' ? 'checked' : r.answer_type === 'excerpt' ? 'excerpt' : r.status;
    return `${r.id} · ${when} · ${r.mode ?? 'standard'} · ${kind} · ${r.query ?? ''}`;
  });
  if (list.has_more) lines.push(`More runs available: pass starting_after=${list.data.at(-1)?.id}.`);
  return lines.join('\n');
}

export function formatWallet(w: Wallet): string {
  const lines = [
    `Available: ${w.available.toLocaleString('en-US')} credits${w.held ? ` (${w.held.toLocaleString('en-US')} held by runs in progress)` : ''}`,
  ];
  if (w.plan) lines.push(`Plan: ${w.plan}${w.wallet === 'organization' ? ' (team pool)' : ''}`);
  if (typeof w.member_cap === 'number') lines.push(`Your monthly limit in the team pool: ${w.member_cap.toLocaleString('en-US')} credits`);
  const lots = (w.lots ?? []).filter((l) => (l.remaining ?? 0) > 0);
  if (lots.length) {
    lines.push('', 'Credit lots:');
    for (const l of lots) {
      const exp = l.expires ? new Date(l.expires * 1000).toISOString().slice(0, 10) : 'no expiry';
      lines.push(`- ${l.source ?? 'credits'}: ${l.remaining} of ${l.granted ?? l.remaining}, expires ${exp}`);
    }
  }
  return lines.join('\n');
}
