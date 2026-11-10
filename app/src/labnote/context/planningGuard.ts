// Planning-only guard (spec §6.3). parsePlanningReply keeps only the requested
// planning sections of a model reply; applyPlanningDraft writes them into the
// target unit op only. Results & Discussions, QC Metrics, Discussion and Meta
// are never kept and never written, under any heading style or label.
import { listUnitOpBlocks, neutralizeIssueMarkers } from '@labnoteo/core';
import { stepFence, type OpenFence } from '../../../vendor/labnoteo/packages/labnoteo-core/src/sections/sectionEdit';
import { toNoteCallout } from '../port/aiDraftMethod';
import { canonicalSection, isPlaceholderBody, RESEARCHER_ONLY_SECTIONS, type UnitOpKind } from './chain';
import { draftableSectionsFor, planningOnly } from './planningPrompt';

// ---------------------------------------------------------------- parse

/**
 * Names that read as results, QC, discussion or meta although they are not a
 * canonical section name; a heading like that starts a section that is dropped.
 */
const RESEARCHER_LIKE_RE =
  /^(results?\b|outcomes?\b|findings?\b|observations?\b|qc\b|quality control|discussions?\b|conclusions?\b|meta(data)?\b|결과|논의|토의|고찰|결론|관찰|메타|qc\s*지표|품질)/i;

const HASH_HEADING_RE = /^\s{0,3}#{2,6}\s+(.+?)\s*#*\s*$/;
const BOLD_HEADING_RE = /^\s{0,3}\*\*(.+?)\*\*\s*:?\s*$/;
const COLON_HEADING_RE = /^\s{0,3}([^\s:#*>`|-][^:]{0,60}?)\s*:\s*(.*)$/;
const SOURCE_LINE_RE = /^\s*<\\?<\/?source\b.*$/i;
const FENCE_OPEN_RE = /^\s*(`{3,}|~{3,})[^`]*$/;

/** The name of a heading with numbering, bold markers and a trailing colon removed. */
function cleanName(raw: string): string {
  return raw
    .replace(/^\*\*(.*)\*\*$/, '$1')
    .replace(/^\d+[.)]\s*/, '')
    .replace(/\s*:\s*$/, '')
    .replace(/^\*\*(.*)\*\*$/, '$1')
    .trim();
}

type HeadingHit = { name: string; canon: string | undefined; rest?: string };

/** The section heading on `line`, or undefined. Weak styles (bold, `Name:`) count only for a known or researcher-like name. */
function headingOf(line: string): HeadingHit | undefined {
  const hash = HASH_HEADING_RE.exec(line);
  if (hash) {
    const name = cleanName(hash[1]);
    return { name, canon: canonicalSection(name) };
  }
  const known = (name: string) => canonicalSection(name) !== undefined || RESEARCHER_LIKE_RE.test(name.normalize('NFC'));
  const bold = BOLD_HEADING_RE.exec(line);
  if (bold) {
    const name = cleanName(bold[1]);
    if (known(name)) return { name, canon: canonicalSection(name) };
    return undefined;
  }
  const colon = COLON_HEADING_RE.exec(line);
  if (colon) {
    const name = cleanName(colon[1]);
    if (known(name))
      return {
        name,
        canon: canonicalSection(name),
        rest: colon[2].trim() || undefined,
      };
  }
  return undefined;
}

/** The reply without one code fence around all of it. */
function stripOuterFence(reply: string): string {
  const lines = reply.trim().split(/\r?\n/);
  if (lines.length >= 2 && FENCE_OPEN_RE.test(lines[0])) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(lines[0])![1];
    const last = lines[lines.length - 1].trim();
    if (last.startsWith(marker[0]) && last.length >= marker.length && /^(`+|~+)$/.test(last)) return lines.slice(1, -1).join('\n');
  }
  return lines.join('\n');
}

/**
 * The requested planning sections of a model reply (canonical name -> trimmed
 * body), and the names of every other section the model wrote. Researcher-only
 * sections are dropped even when requested.
 */
export function parsePlanningReply(reply: string, requested: readonly string[]): { sections: Map<string, string>; dropped: string[] } {
  const wanted = new Set(planningOnly(requested));
  const text = stripOuterFence(reply.normalize('NFC'))
    .split('\n')
    .filter(l => !SOURCE_LINE_RE.test(l));

  const parts: { name: string; canon: string | undefined; body: string[] }[] = [];
  let fence: OpenFence | null = null;
  for (const line of text) {
    const next = stepFence(line, fence);
    const inFence = fence !== null || next !== fence;
    fence = next;
    const hit = inFence ? undefined : headingOf(line);
    if (hit) {
      parts.push({
        name: hit.name,
        canon: hit.canon,
        body: hit.rest ? [hit.rest] : [],
      });
    } else if (parts.length > 0) {
      parts[parts.length - 1].body.push(line);
    }
  }

  const sections = new Map<string, string>();
  const dropped: string[] = [];
  for (const part of parts) {
    const body = part.body.join('\n').trim();
    const name = part.canon ?? part.name;
    const keep = part.canon !== undefined && wanted.has(part.canon) && !RESEARCHER_ONLY_SECTIONS.includes(part.canon);
    if (!keep) {
      if (!dropped.includes(name)) dropped.push(name);
      continue;
    }
    if (body === '') continue;
    const before = sections.get(part.canon!);
    sections.set(part.canon!, before ? `${before}\n\n${body}` : body);
  }
  return { sections, dropped };
}

// ---------------------------------------------------------------- apply

/** Template order of every section a unit op of `kind` may hold (spec §6.1). */
const TEMPLATE_ORDER: Record<UnitOpKind, readonly string[]> = {
  hw: [
    'Meta',
    'Input',
    'Reagent',
    'Labware and Consumables',
    'Equipment',
    'Parameters',
    'Method',
    'Output',
    'Environment',
    'Results & Discussions',
    'QC Metrics',
    'Discussion',
  ],
  sw: ['Meta', 'Input', 'Output', 'Parameters', 'QC Metrics', 'Method', 'Environment', 'Discussion', 'Results & Discussions'],
  unknown: [
    'Meta',
    'Input',
    'Reagent',
    'Labware and Consumables',
    'Equipment',
    'Parameters',
    'Method',
    'Output',
    'Environment',
    'Results & Discussions',
    'QC Metrics',
    'Discussion',
  ],
};

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
const sameHeading = (a: string, b: string): boolean => a.normalize('NFC').trimEnd() === b.normalize('NFC').trimEnd();

interface Edit {
  start: number;
  end: number;
  text: string;
  /** Template rank, so several inserts at one offset land in template order. */
  rank: number;
}

/**
 * `md` with the draft written into the planning sections of the unit op at
 * the 0-based `unitOpIndex`, or null when the heading there changed (the note
 * moved while the model answered). An empty or placeholder-only section is
 * replaced by the draft under the AI header; after researcher text the draft
 * is appended as an AI callout; a missing planning heading is inserted in
 * template order. Researcher-only sections, sections the kind does not draft,
 * and every byte outside the touched sections are kept as they are.
 */
export function applyPlanningDraft(
  md: string,
  target: { unitOpIndex: number; heading: string; kind: UnitOpKind },
  sections: Map<string, string>,
  header: string
): string | null {
  const block = listUnitOpBlocks(md)[target.unitOpIndex];
  const lines = linesOf(md);
  if (!block || !sameHeading(lines[block.headingLine].text, target.heading)) return null;
  const eol = md.includes('\r\n') ? '\r\n' : '\n';
  const order = TEMPLATE_ORDER[target.kind];
  const rankOf = (name: string | undefined): number => (name === undefined ? -1 : order.indexOf(name));
  const allowed = new Set(draftableSectionsFor(target.kind, { environment: true }));

  // `####` sections of the block, outside code fences.
  const found: { name: string | undefined; line: number; end: number }[] = [];
  let fence: OpenFence | null = null;
  for (let i = block.headingLine + 1; i < block.contentEndLine; i++) {
    const next = stepFence(lines[i].text, fence);
    const inFence = fence !== null || next !== fence;
    fence = next;
    const m = inFence ? null : SECTION_HEADING_RE.exec(lines[i].text);
    if (!m) continue;
    if (found.length > 0) found[found.length - 1].end = i;
    found.push({
      name: canonicalSection(m[1]),
      line: i,
      end: block.contentEndLine,
    });
  }

  /** The last non-blank line in `[from, to)`, or `from - 1`. */
  const lastFilled = (from: number, to: number): number => {
    let i = to - 1;
    while (i >= from && isBlank(lines[i].text)) i--;
    return i;
  };
  const lineEnd = (i: number): number => lines[i].start + lines[i].text.length;
  const toEol = (text: string): string => text.split(/\r?\n/).join(eol);
  const drafted = (body: string): string => toEol(`> [!note] ${header}\n\n${neutralizeIssueMarkers(body.trim())}`);

  const edits: Edit[] = [];
  for (const [rawName, rawBody] of sections) {
    const name = canonicalSection(rawName);
    const body = rawBody.trim();
    if (!name || body === '' || !allowed.has(name) || RESEARCHER_ONLY_SECTIONS.includes(name)) continue;
    const rank = rankOf(name);
    const existing = found.find(s => s.name === name);

    if (existing) {
      const from = existing.line + 1;
      const last = lastFilled(from, existing.end);
      const text = lines
        .slice(from, existing.end)
        .map(l => l.text)
        .join('\n');
      if (isPlaceholderBody(name, text)) {
        if (last < from) {
          const follow = lines[existing.line + 1];
          const gap = follow !== undefined && !isBlank(follow.text) && existing.line + 1 < block.contentEndLine ? eol : '';
          edits.push({
            start: lineEnd(existing.line),
            end: lineEnd(existing.line),
            text: eol + drafted(body) + gap,
            rank,
          });
        } else {
          let first = from;
          while (isBlank(lines[first].text)) first++;
          edits.push({
            start: lines[first].start,
            end: lineEnd(last),
            text: drafted(body),
            rank,
          });
        }
      } else {
        edits.push({
          start: lineEnd(last),
          end: lineEnd(last),
          text: eol + eol + toEol(toNoteCallout(body, header)),
          rank,
        });
      }
      continue;
    }

    // A missing heading: after the closest earlier section in template order,
    // else before the closest later one, else at the end of the block.
    const newSection = `#### ${name}${eol}${drafted(body)}`;
    const before = found.filter(s => rankOf(s.name) >= 0 && rankOf(s.name) < rank).pop();
    if (before) {
      const at = lineEnd(Math.max(lastFilled(before.line + 1, before.end), before.line));
      edits.push({ start: at, end: at, text: eol + eol + newSection, rank });
      continue;
    }
    const after = found.find(s => rankOf(s.name) > rank);
    if (after) {
      const at = lines[after.line].start;
      edits.push({
        start: at,
        end: at,
        text: newSection + eol + eol,
        rank: rank - order.length,
      });
      continue;
    }
    const at = lineEnd(Math.max(lastFilled(block.headingLine + 1, block.contentEndLine), block.headingLine));
    edits.push({ start: at, end: at, text: eol + eol + newSection, rank });
  }

  // Later offsets first; at one offset the later template rank first, so the
  // earlier one ends up in front of it.
  edits.sort((a, b) => b.start - a.start || b.rank - a.rank);
  let out = md;
  for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}
