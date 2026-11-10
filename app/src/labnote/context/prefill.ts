// Deterministic Input prefill (spec §7): the previous unit op's Output sample
// IDs become the target's Input. Across a workflow boundary the last Output of
// workflow N feeds the first Input of workflow N+1. Never calls the LLM.
import { listUnitOpBlocks } from '@labnoteo/core';
import { stepFence, type OpenFence } from '../../../vendor/labnoteo/packages/labnoteo-core/src/sections/sectionEdit';
import { canonicalSection, isPlaceholderBody, previousUnitOp, sampleIdsIn, type ExperimentChain, type UnitOpTarget } from './chain';

export type PrefillResult =
  | { ids: string[]; lines: string[]; from: { path: string; heading: string } }
  | { reason: 'noPrevious' | 'noOutput' };

/**
 * The Input lines for `target`: the previous unit op's Output IDs, in order,
 * as `- <ID> — <name>` (the name only when `registryName` knows it). The
 * caller's `registryName` looks in the scope folder's registry, then the global one.
 */
export function prefillInput(
  chain: ExperimentChain,
  target: UnitOpTarget,
  registryName: (id: string) => string | undefined
): PrefillResult {
  const previous = previousUnitOp(chain, target);
  if (!previous) return { reason: 'noPrevious' };
  if (previous.outputIds.length === 0) return { reason: 'noOutput' };
  const ids = [...previous.outputIds];
  const lines = ids.map(id => {
    const name = registryName(id)?.trim();
    return name ? `- ${id} — ${name}` : `- ${id}`;
  });
  return { ids, lines, from: { path: previous.workflowPath, heading: previous.heading } };
}

interface Line {
  start: number;
  text: string;
}

function linesOf(md: string): Line[] {
  const out: Line[] = [];
  let start = 0;
  for (const text of md.split(/\r?\n/)) {
    out.push({ start, text });
    start += text.length;
    start += md.startsWith('\r\n', start) ? 2 : md.startsWith('\n', start) ? 1 : 0;
  }
  return out;
}

const SECTION_HEADING_RE = /^####\s+(.+?)\s*#*\s*$/;
const isBlank = (text: string): boolean => text.trim() === '';
const typeOfId = (id: string): string => id.replace(/(-\d+)+$/, '');
const sameHeading = (a: string, b: string): boolean => a.normalize('NFC').trimEnd() === b.normalize('NFC').trimEnd();

/**
 * `md` with the prefill written into the Input of the unit op at the 0-based
 * `unitOpIndex`, or undefined when nothing changes: no result, no unit op
 * there, a different heading there (the note moved), or every ID present.
 * An empty or placeholder-only Input is replaced; otherwise only missing IDs
 * are appended. A missing `#### Input` goes right after Meta, else right
 * after the unit op heading. Bytes outside that Input section are kept.
 */
export function applyPrefill(md: string, target: { unitOpIndex: number; heading: string }, result: PrefillResult): string | undefined {
  if ('reason' in result || result.ids.length === 0) return undefined;
  const block = listUnitOpBlocks(md)[target.unitOpIndex];
  const lines = linesOf(md);
  if (!block || !sameHeading(lines[block.headingLine].text, target.heading)) return undefined;
  const eol = md.includes('\r\n') ? '\r\n' : '\n';

  // `####` sections of the block, outside code fences.
  const sections: { name: string | undefined; line: number; end: number }[] = [];
  let fence: OpenFence | null = null;
  for (let i = block.headingLine + 1; i < block.contentEndLine; i++) {
    const next = stepFence(lines[i].text, fence);
    const inFence = fence !== null || next !== fence;
    fence = next;
    const m = inFence ? null : SECTION_HEADING_RE.exec(lines[i].text);
    if (!m) continue;
    if (sections.length > 0) sections[sections.length - 1].end = i;
    sections.push({ name: canonicalSection(m[1]), line: i, end: block.contentEndLine });
  }

  /** Inserts `added` before line `at` (or at the very end). */
  const insertAt = (at: number, added: string[]): string => {
    const follow = lines[at];
    const tail = follow !== undefined && !isBlank(follow.text) ? [...added, ''] : added;
    if (at >= lines.length) return md + eol + tail.join(eol);
    const offset = lines[at].start;
    return md.slice(0, offset) + tail.map(l => l + eol).join('') + md.slice(offset);
  };
  /** The last non-blank line in `[from, to)`, or `from - 1`. */
  const lastFilled = (from: number, to: number): number => {
    let i = to - 1;
    while (i >= from && isBlank(lines[i].text)) i--;
    return i;
  };

  const input = sections.find(s => s.name === 'Input');
  if (!input) {
    const meta = sections.find(s => s.name === 'Meta');
    const after = meta ? Math.max(lastFilled(meta.line + 1, meta.end), meta.line) : block.headingLine;
    return insertAt(after + 1, ['', '#### Input', ...result.lines]);
  }

  const from = input.line + 1;
  const body = lines.slice(from, input.end).map(l => l.text);
  const last = lastFilled(from, input.end);
  if (isPlaceholderBody('Input', body.join('\n'))) {
    if (last < from) return insertAt(from, result.lines);
    let first = from;
    while (isBlank(lines[first].text)) first++;
    const startAt = lines[first].start;
    const endAt = lines[last].start + lines[last].text.length;
    return md.slice(0, startAt) + result.lines.join(eol) + md.slice(endAt);
  }

  const bodyText = body.join('\n');
  const missing = result.lines.filter((_, i) => {
    const id = result.ids[i];
    return !sampleIdsIn(bodyText, [typeOfId(id)]).includes(id);
  });
  if (missing.length === 0) return undefined;
  return insertAt(last + 1, missing);
}
