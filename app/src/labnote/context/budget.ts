// Budget and trim of AI context sources (spec §5.5). Deterministic and pure:
// no LLM call, no I/O, the input is never mutated. It runs after the user's
// unticks and whenever the context window changes.
//
// Order of filling:
//  1. Required sources (target, target catalog) are always kept. If they alone
//     exceed the budget, the target's longest section is cut to its first 400
//     characters, `overBudget` is set and nothing else is sent.
//  2. The previous unit op, the input prefill and the goal (cut to 1500 tokens),
//     each at the best form that fits.
//  3. Earlier unit ops of the current workflow, nearest first: every one is
//     first secured as an outline, then the spare budget upgrades them nearest
//     first: verbatim for the nearest (up to half the spare unless all fit),
//     summaries for the next ones. A farther unit op is never shown in more
//     detail than a nearer one: the nearest steps stay verbatim, older ones are
//     summarised, then outlined, then dropped.
//  4. Samples > catalog of other ops > earlier workflows (nearest first) >
//     named folders > ticked results, each kept whole or dropped.
// A source the user unticked (`reason: 'user'`) is never re-included; a trimmed
// one is reconsidered (from its `fullText`) on every run.
import { isPlaceholderBody, type UnitOpNode } from './chain';
import { estimateTokens, truncateToTokens } from './tokens';
import type { ContextSource, SourceMode } from './types';
import { stepFence, type OpenFence } from '../../../vendor/labnoteo/packages/labnoteo-core/src/sections/sectionEdit';

/** Share of the context window given to the prompt; the rest is left for the reply. */
export const PROMPT_SHARE = 0.6;
/** The README goal is cut to this many tokens. */
export const GOAL_MAX_TOKENS = 1500;
/** Over budget, the target's longest section keeps this many characters. */
export const TARGET_SECTION_CUT = 400;
/** Lines of Method in a unit op summary. */
export const SUMMARY_METHOD_LINES = 2;
/** Parameter lines in a unit op summary. */
export const SUMMARY_PARAMETER_LINES = 10;
/** Characters kept per summary line. */
const SUMMARY_LINE_CHARS = 160;
const ELLIPSIS = '…';

export interface BudgetResult {
  sources: ContextSource[];
  totalTokens: number;
  budget: number;
  overBudget: boolean;
  /** Ids of sources dropped or shortened by this run, in input order. */
  trimmed: string[];
}

/** Prompt budget: `floor(window * 0.6) - fixed`, never below 0. */
export function contextBudget(windowTokens: number, fixedTokens: number): number {
  const b = Math.floor(windowTokens * PROMPT_SHARE) - fixedTokens;
  return Number.isFinite(b) ? Math.max(0, b) : 0;
}

// ---------------------------------------------------------------- summaries

function capLine(line: string): string {
  const chars = Array.from(line);
  return chars.length <= SUMMARY_LINE_CHARS ? line : chars.slice(0, SUMMARY_LINE_CHARS).join('').trimEnd() + ELLIPSIS;
}

/** Non-blank lines of `body` outside code fences, trimmed. */
function plainLines(body: string): string[] {
  const out: string[] = [];
  let fence: OpenFence | null = null;
  for (const line of body.split(/\r?\n/)) {
    const next = stepFence(line, fence);
    const inFence = fence !== null || next !== fence;
    fence = next;
    if (!inFence && line.trim() !== '') out.push(line.trim());
  }
  return out;
}

const TABLE_SEPARATOR_RE = /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/;
const BULLET_RE = /^(?:[-*+]|\d+[.)])\s+/;

function tableCells(line: string): string[] {
  return line
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map(c => c.trim());
}

/** Parameters as `key: value` lines (bullets or table rows; the table header is skipped). */
function parameterLines(body: string): string[] {
  const lines = plainLines(body);
  const out: string[] = [];
  lines.forEach((line, i) => {
    if (line.startsWith('|')) {
      if (TABLE_SEPARATOR_RE.test(line)) return;
      if (i + 1 < lines.length && TABLE_SEPARATOR_RE.test(lines[i + 1])) return; // header row
      const cells = tableCells(line).filter(c => c !== '');
      if (cells.length === 0) return;
      out.push(cells.length === 1 ? cells[0] : `${cells[0]}: ${cells.slice(1).join(' | ')}`);
      return;
    }
    const text = line.replace(BULLET_RE, '').trim();
    if (text) out.push(text);
  });
  return out;
}

function idLines(uo: UnitOpNode): string[] {
  const ids = (list: readonly string[]) => (list.length > 0 ? list.join(', ') : '(none)');
  return [`Input: ${ids(uo.inputIds)}`, `Output: ${ids(uo.outputIds)}`];
}

/** Heading plus Input/Output IDs. */
export function outlineUnitOp(uo: UnitOpNode): string {
  return [uo.heading, ...idLines(uo)].join('\n');
}

/**
 * Deterministic summary (no LLM): heading, Input/Output IDs, the first 2 lines
 * of Method and up to 10 Parameters as `key: value` lines. Placeholder
 * sections are left out.
 */
export function summariseUnitOp(uo: UnitOpNode): string {
  const out = [uo.heading, ...idLines(uo)];
  const method = uo.sections.Method ?? '';
  if (!isPlaceholderBody('Method', method)) {
    const lines = plainLines(method).slice(0, SUMMARY_METHOD_LINES);
    if (lines.length > 0) out.push('Method:', ...lines.map(capLine));
  }
  const params = uo.sections.Parameters ?? '';
  if (!isPlaceholderBody('Parameters', params)) {
    const lines = parameterLines(params).slice(0, SUMMARY_PARAMETER_LINES);
    if (lines.length > 0) out.push('Parameters:', ...lines.map(capLine));
  }
  return out.join('\n');
}

// ---------------------------------------------------------------- target cut

const SECTION_LINE_RE = /^####\s/;

/** `text` with its longest `####` section body cut to its first 400 characters. */
function cutLongestSection(text: string): string {
  const lines = text.split('\n');
  const starts: number[] = [];
  let fence: OpenFence | null = null;
  lines.forEach((line, i) => {
    const next = stepFence(line, fence);
    const inFence = fence !== null || next !== fence;
    fence = next;
    if (!inFence && SECTION_LINE_RE.test(line)) starts.push(i);
  });
  // Body ranges [from, to): after each heading, or after the first line when there is none.
  const ranges: [number, number][] =
    starts.length === 0
      ? [[Math.min(1, lines.length), lines.length]]
      : starts.map((s, k) => [s + 1, k + 1 < starts.length ? starts[k + 1] : lines.length]);
  let best = ranges[0];
  let bestLen = -1;
  for (const r of ranges) {
    const len = lines.slice(r[0], r[1]).join('\n').length;
    if (len > bestLen) {
      best = r;
      bestLen = len;
    }
  }
  const body = Array.from(lines.slice(best[0], best[1]).join('\n'));
  if (body.length <= TARGET_SECTION_CUT) return text;
  const cut = body.slice(0, TARGET_SECTION_CUT).join('') + ELLIPSIS;
  return [...lines.slice(0, best[0]), cut, ...lines.slice(best[1])].join('\n');
}

// ---------------------------------------------------------------- applyBudget

interface Form {
  mode: SourceMode;
  text: string;
  tokens: number;
}

interface Entry {
  /** The source restored to its full text, required ones ticked, trimmed ones reconsidered. */
  src: ContextSource;
  /** Candidate forms, best first. */
  forms: Form[];
  candidate: boolean;
  /** Index into `forms`, or -1 when not placed. */
  chosen: number;
  rank: number;
  index: number;
}

/** Ranks of spec §5.5 (lower first). */
function rankOf(s: ContextSource): number {
  switch (s.kind) {
    case 'target':
      return 0;
    case 'unitOp':
      return s.distance <= 1 ? 0 : 3;
    case 'prefill':
      return 1;
    case 'goal':
      return 2;
    case 'sample':
      return 4;
    case 'catalog':
      return 5;
    case 'workflow':
      return 6;
    case 'named':
      return 7;
    case 'results':
      return 8;
    default:
      return 9;
  }
}

const form = (mode: SourceMode, text: string): Form => ({ mode, text, tokens: estimateTokens(text) });

function prepare(s: ContextSource, index: number, uoOf?: (id: string) => UnitOpNode | undefined): Entry {
  const { fullText, reason, ...rest } = s;
  const src: ContextSource = { ...rest };
  if (fullText !== undefined) {
    src.text = fullText;
    src.mode = 'verbatim';
  }
  src.tokens = estimateTokens(src.text);
  if (s.required || (s.included && reason !== 'user')) src.included = true;
  else if (reason === 'trimmed') src.included = true;
  else {
    src.included = false;
    if (reason !== undefined) src.reason = reason;
  }

  let forms: Form[] = [form(src.mode, src.text)];
  if (src.kind === 'goal') forms = [form(src.mode, truncateToTokens(src.text, GOAL_MAX_TOKENS))];
  if (src.kind === 'unitOp' && src.mode === 'verbatim') {
    const uo = uoOf?.(src.id);
    if (uo) forms = [forms[0], form('summary', summariseUnitOp(uo)), form('outline', outlineUnitOp(uo))];
  }
  return { src, forms, candidate: src.included, chosen: -1, rank: s.required ? -1 : rankOf(src), index };
}

/**
 * Upgrades placed unit ops (nearest first) with `spare` tokens. When every one
 * fits verbatim, all are upgraded. Otherwise half of the spare goes to verbatim
 * for the nearest ones, the rest to summaries for the next ones, and what is
 * left upgrades the nearest summaries to verbatim. Each sweep stops at its first
 * miss, so a farther unit op is never shown in more detail than a nearer one.
 * `tryForm(e, f)` places `e` at form `f` and returns the added tokens, or -1.
 */
function upgradeNearestFirst(placed: Entry[], spare: number, tryForm: (e: Entry, f: number) => number): void {
  const cur = (e: Entry) => e.forms[e.chosen].tokens;
  const allVerbatim = placed.reduce((n, e) => n + e.forms[0].tokens - cur(e), 0);
  const verbatimCap = allVerbatim <= spare ? spare : Math.floor(spare / 2);
  let spent = 0;
  let i = 0;
  for (; i < placed.length; i++) {
    const e = placed[i];
    if (e.chosen === 0) continue;
    if (spent + e.forms[0].tokens - cur(e) > verbatimCap) break;
    const added = tryForm(e, 0);
    if (added < 0) break;
    spent += added;
  }
  for (; i < placed.length; i++) {
    const e = placed[i];
    const summary = e.forms.findIndex(f => f.mode === 'summary');
    if (summary < 0 || e.chosen <= summary) continue;
    if (tryForm(e, summary) < 0) break;
  }
  for (const e of placed) {
    if (e.chosen === 0) continue;
    if (e.forms[e.chosen].mode !== 'summary' || tryForm(e, 0) < 0) break;
  }
}

/**
 * Fits the included sources into `budget` tokens (see the order at the top of
 * this file). `uoOf` maps a `unitOp` source id to its node, so it can be
 * summarised or outlined; without it a unit op is kept whole or dropped.
 */
export function applyBudget(
  sources: ContextSource[],
  budget: number,
  uoOf?: (id: string) => UnitOpNode | undefined
): BudgetResult {
  const limit = Number.isFinite(budget) ? Math.max(0, Math.floor(budget)) : 0;
  const entries = sources.map((s, i) => prepare(s, i, uoOf));
  let used = 0;
  let overBudget = false;

  const cost = (e: Entry): number => (e.chosen >= 0 ? e.forms[e.chosen].tokens : 0);
  /** Places `e` at the best form from `from` on that fits; returns whether it moved. */
  const place = (e: Entry, from: number, to: number): boolean => {
    for (let f = from; f <= to; f++) {
      if (used - cost(e) + e.forms[f].tokens <= limit) {
        used += e.forms[f].tokens - cost(e);
        e.chosen = f;
        return true;
      }
    }
    return false;
  };

  const ordered = entries
    .filter(e => e.candidate)
    .sort((a, b) => a.rank - b.rank || a.src.distance - b.src.distance || a.index - b.index);

  // 1. Required sources, always kept.
  const required = ordered.filter(e => e.rank === -1);
  for (const e of required) {
    e.chosen = 0;
    used += e.forms[0].tokens;
  }
  if (used > limit) {
    overBudget = true;
    for (const e of required.filter(x => x.src.kind === 'target')) {
      const cut = form(e.forms[0].mode, cutLongestSection(e.forms[0].text));
      used += cut.tokens - e.forms[0].tokens;
      e.forms = [cut];
    }
  }

  // Over budget, only the required sources are sent.
  const rest = overBudget ? [] : ordered;

  // 2. Previous unit op, input prefill, goal: best form that fits.
  for (const e of rest.filter(x => x.rank >= 0 && x.rank <= 2)) place(e, 0, e.forms.length - 1);

  // 3. Earlier unit ops: secure outlines nearest first, then upgrade nearest first.
  const earlier = rest.filter(x => x.rank === 3);
  for (const e of earlier) place(e, e.forms.length - 1, e.forms.length - 1);
  upgradeNearestFirst(
    earlier.filter(e => e.chosen >= 0),
    limit - used,
    (e, f) => {
      const before = used;
      return place(e, f, f) ? used - before : -1;
    }
  );

  // 4. Everything else, whole or not at all.
  for (const e of rest.filter(x => x.rank >= 4)) place(e, 0, e.forms.length - 1);

  const trimmed: string[] = [];
  const out = entries.map(e => {
    if (!e.candidate) return e.src;
    if (e.chosen < 0) {
      trimmed.push(e.src.id);
      return { ...e.src, included: false, reason: 'trimmed' as const };
    }
    const f = e.forms[e.chosen];
    if (f.text === e.src.text) return { ...e.src, mode: f.mode, tokens: f.tokens };
    trimmed.push(e.src.id);
    return { ...e.src, text: f.text, mode: f.mode, tokens: f.tokens, fullText: e.src.text };
  });
  const totalTokens = out.reduce((n, s) => n + (s.included ? s.tokens : 0), 0);
  return { sources: out, totalTokens, budget: limit, overBudget: overBudget || totalTokens > limit, trimmed };
}

/**
 * `sources` with `id` ticked or unticked by the user. Unticking sets
 * `reason: 'user'`; ticking clears the reason. A required or unknown id is a no-op.
 */
export function toggleSource(sources: ContextSource[], id: string, on: boolean): ContextSource[] {
  const target = sources.find(s => s.id === id);
  if (!target || target.required) return sources;
  return sources.map(s => {
    if (s.id !== id) return s;
    if (!on) return { ...s, included: false, reason: 'user' as const };
    const { reason: _reason, ...rest } = s;
    return { ...rest, included: true };
  });
}
