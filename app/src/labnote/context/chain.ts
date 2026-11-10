// Experiment chain model for the AI context builder (spec §4.2, §4.3).
// One experiment folder: README goal, workflows in checklist order, their unit
// ops with canonical sections and sample IDs. Problems are reported as chain
// issues, never thrown and never guessed. Reads stay inside `folder`.
import type { LabnoteFs } from '@labnoteo/core';
import { listUnitOpBlocks } from '@labnoteo/core';
import { buildSampleIdPattern, SAMPLE_TYPES } from '@labnoteo/core/lib/sampleUtils';
import { HW_PLACEHOLDERS, SW_PLACEHOLDERS } from '@labnoteo/core/lib/unitOpTemplate';
import {
  defaultWorkflowTitle,
  parseWorkflowChecklistFromReadme,
  workflowChecklistSectionRange,
} from '@labnoteo/core/lib/workflowStructure';
import { normalizeHeadingText, stepFence, type OpenFence } from '../../../vendor/labnoteo/packages/labnoteo-core/src/sections/sectionEdit';

/** Planning sections of a hardware (lab) unit op, in template order; the AI may draft these. */
export const PLANNING_SECTIONS_HW: readonly string[] = [
  'Input',
  'Reagent',
  'Labware and Consumables',
  'Equipment',
  'Parameters',
  'Method',
  'Output',
];
/** Planning sections of a software unit op, in template order (Environment only when ticked). */
export const PLANNING_SECTIONS_SW: readonly string[] = ['Input', 'Output', 'Parameters', 'Method', 'Environment'];
/** Sections the AI never writes (spec §6). */
export const RESEARCHER_ONLY_SECTIONS: readonly string[] = ['Results & Discussions', 'QC Metrics', 'Discussion', 'Meta'];

/** At most this many workflow files are read per folder. */
export const MAX_WORKFLOW_FILES = 200;
/** Files larger than this (UTF-8 bytes) are not parsed. */
export const MAX_FILE_BYTES = 2 * 1024 * 1024;

export type ChainIssueCode =
  | 'missingReadme'
  | 'emptyChecklist'
  | 'brokenLink'
  | 'unlistedWorkflow'
  | 'noUnitOps'
  | 'noOutput'
  | 'duplicateEntry'
  | 'unreadable';

export interface ChainIssue {
  code: ChainIssueCode;
  path?: string;
  detail?: string;
}

export type UnitOpKind = 'hw' | 'sw' | 'unknown';

export interface UnitOpNode {
  workflowPath: string;
  /** 0-based position among the note's unit ops (core `listUnitOpBlocks` is 1-based). */
  index: number;
  /** The full heading line. */
  heading: string;
  opId: string;
  title: string;
  alias: string;
  kind: UnitOpKind;
  /** Canonical section name (or the heading text of an unknown section) -> trimmed body. */
  sections: Record<string, string>;
  inputIds: string[];
  outputIds: string[];
}

export interface WorkflowNode {
  path: string;
  fileName: string;
  label: string;
  listed: boolean;
  done: boolean;
  /** A name without `.labnote.md`. */
  legacy: boolean;
  unitOps: UnitOpNode[];
}

export interface ExperimentChain {
  folder: string;
  readmePath?: string;
  /** README body minus front matter and the checklist section. */
  goal: string;
  /** Checklist order, then legacy by label, then unlisted by number. */
  workflows: WorkflowNode[];
  issues: ChainIssue[];
}

export interface UnitOpTarget {
  workflowPath: string;
  unitOpIndex: number;
}

// ---------------------------------------------------------------- sections

const CANONICAL_SECTIONS = [
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
] as const;

const SECTION_ALIASES: Record<string, string> = {
  consumables: 'Labware and Consumables',
  'labware & consumables': 'Labware and Consumables',
  'results and discussions': 'Results & Discussions',
  'results & discussion': 'Results & Discussions',
  'results and discussion': 'Results & Discussions',
  입력: 'Input',
  시약: 'Reagent',
  소모품: 'Labware and Consumables',
  장비: 'Equipment',
  파라미터: 'Parameters',
  방법: 'Method',
  출력: 'Output',
  환경: 'Environment',
  결과: 'Results & Discussions',
  '결과 및 논의': 'Results & Discussions',
  'qc 지표': 'QC Metrics',
  논의: 'Discussion',
  메타: 'Meta',
};

const SECTION_KEYS: ReadonlyMap<string, string> = new Map([
  ...CANONICAL_SECTIONS.map(name => [normalizeHeadingText(name), name] as const),
  ...Object.entries(SECTION_ALIASES).map(([k, v]) => [normalizeHeadingText(k.normalize('NFC')), v] as const),
]);

/** The English canonical name of a section heading (Korean labels and the `Consumables` alias included), or undefined. */
export function canonicalSection(name: string): string | undefined {
  const text = name.normalize('NFC').trim().replace(/^#+\s*/, '');
  return SECTION_KEYS.get(normalizeHeadingText(text));
}

const PLACEHOLDERS: Record<string, string>[] = [HW_PLACEHOLDERS, SW_PLACEHOLDERS];

/** Whether `body` is empty or only the template placeholder of `section`. */
export function isPlaceholderBody(section: string, body: string): boolean {
  const text = body.trim();
  if (text === '') return true;
  const canon = canonicalSection(section) ?? section;
  return PLACEHOLDERS.some(p => p[canon] !== undefined && p[canon].trim() === text);
}

// ---------------------------------------------------------------- sample IDs

const NEW_LINE_RE = /\(new:/i;
const INLINE_CODE_RE = /(`+)[\s\S]*?\1/g;

/** Sample IDs of `types` in `text`, outside code fences and inline code, de-duplicated in first-seen order. `(new: …)` lines give none. */
export function sampleIdsIn(text: string, types: readonly string[]): string[] {
  const kept: string[] = [];
  let fence: OpenFence | null = null;
  for (const line of text.normalize('NFC').split(/\r?\n/)) {
    const next = stepFence(line, fence);
    if (next !== fence) {
      fence = next;
      continue;
    }
    if (fence || NEW_LINE_RE.test(line)) continue;
    kept.push(line.replace(INLINE_CODE_RE, m => ' '.repeat(m.length)));
  }
  const clean = kept.join('\n');
  const found: { at: number; id: string }[] = [];
  for (const type of new Set(types.map(t => t.normalize('NFC')))) {
    if (!type) continue;
    for (const m of clean.matchAll(buildSampleIdPattern(type))) found.push({ at: m.index ?? 0, id: m[0] });
  }
  found.sort((a, b) => a.at - b.at);
  return [...new Set(found.map(f => f.id))];
}

// ---------------------------------------------------------------- unit ops

const SECTION_HEADING_RE = /^####\s+(.+?)\s*#*\s*$/;

function kindOf(opId: string): UnitOpKind {
  if (opId.startsWith('UHW')) return 'hw';
  if (opId.startsWith('USW')) return 'sw';
  return 'unknown';
}

/** `####` sections of lines `[from, to)`, outside code fences. */
function sectionsOf(lines: readonly string[], from: number, to: number): Record<string, string> {
  const sections: Record<string, string> = {};
  let fence: OpenFence | null = null;
  let current: { key: string; body: string[] } | undefined;
  const flush = () => {
    if (current && !(current.key in sections)) sections[current.key] = current.body.join('\n').trim();
  };
  for (let i = from; i < to; i++) {
    const line = lines[i];
    const next = stepFence(line, fence);
    const inFence = fence !== null || next !== fence;
    fence = next;
    const m = inFence ? null : SECTION_HEADING_RE.exec(line);
    if (m) {
      flush();
      const text = m[1].normalize('NFC');
      current = { key: canonicalSection(text) ?? text, body: [] };
    } else if (current) {
      current.body.push(line);
    }
  }
  flush();
  return sections;
}

function unitOpsOf(md: string, workflowPath: string, types: readonly string[]): UnitOpNode[] {
  const lines = md.split(/\r?\n/);
  return listUnitOpBlocks(md).map(b => {
    const sections = sectionsOf(lines, b.headingLine + 1, b.contentEndLine);
    return {
      workflowPath,
      index: b.index - 1,
      heading: lines[b.headingLine].trimEnd(),
      opId: b.opId,
      title: b.opName,
      alias: b.alias,
      kind: kindOf(b.opId),
      sections,
      inputIds: sampleIdsIn(sections.Input ?? '', types),
      outputIds: sampleIdsIn(sections.Output ?? '', types),
    };
  });
}

/** 0-based index of the unit op block containing the 0-based `line`, or undefined. */
export function unitOpAtLine(md: string, line: number): number | undefined {
  const block = listUnitOpBlocks(md).find(b => line >= b.headingLine && line < b.endLine);
  return block ? block.index - 1 : undefined;
}

const keyOf = (path: string): string => path.normalize('NFC').replace(/\\/g, '/').toLowerCase();

/**
 * The unit op before `target` in chain order: the previous one in the same
 * workflow, else the last one of the closest earlier workflow that has any.
 * Undefined at the very first unit op, or for a workflow outside the chain.
 */
export function previousUnitOp(chain: ExperimentChain, target: UnitOpTarget): UnitOpNode | undefined {
  const w = chain.workflows.findIndex(wf => keyOf(wf.path) === keyOf(target.workflowPath));
  if (w === -1) return undefined;
  const own = chain.workflows[w].unitOps;
  if (target.unitOpIndex > 0) return own[Math.min(target.unitOpIndex, own.length) - 1];
  for (let i = w - 1; i >= 0; i--) {
    const ops = chain.workflows[i].unitOps;
    if (ops.length > 0) return ops[ops.length - 1];
  }
  return undefined;
}

// ---------------------------------------------------------------- chain

const WORKFLOW_FILE_RE = /^\d{3}_.*\.md$/i;
const README_NAMES = ['readme.labnote.md', 'readme.md'];
const FRONT_MATTER_RE = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;

const nameKey = (name: string): string => name.normalize('NFC').toLowerCase();
/** A file name or checklist label without `.labnote`/`.md`, for the legacy label match. */
const stemKey = (name: string): string => nameKey(name.trim()).replace(/(\.md)+$/, '').replace(/\.labnote$/, '');
const isLegacyName = (name: string): boolean => !/\.labnote\.md$/i.test(name);

function byNumberThenName(a: string, b: string): number {
  const na = parseInt(a.slice(0, 3), 10);
  const nb = parseInt(b.slice(0, 3), 10);
  return na !== nb ? na - nb : a < b ? -1 : a > b ? 1 : 0;
}

function utf8Bytes(text: string): number {
  if (text.length > MAX_FILE_BYTES) return text.length;
  if (text.length * 3 <= MAX_FILE_BYTES) return text.length;
  return new TextEncoder().encode(text).length;
}

/** Reads `path`; a failure or an oversized file is an `unreadable` issue and gives undefined. */
async function readCapped(fs: LabnoteFs, path: string, issues: ChainIssue[]): Promise<string | undefined> {
  let text: string;
  try {
    text = await fs.read(path);
  } catch (e) {
    issues.push({ code: 'unreadable', path, detail: e instanceof Error ? e.message : String(e) });
    return undefined;
  }
  if (utf8Bytes(text) > MAX_FILE_BYTES) {
    issues.push({ code: 'unreadable', path, detail: 'limit' });
    return undefined;
  }
  return text;
}

function goalOf(readme: string): string {
  const body = readme.replace(FRONT_MATTER_RE, '');
  const lines = body.split(/\r?\n/);
  const range = workflowChecklistSectionRange(body);
  const kept = range ? [...lines.slice(0, range.header), ...lines.slice(range.end)] : lines;
  return kept.join('\n').trim();
}

/**
 * A checklist link as a file name of `folder`, or undefined when it points
 * elsewhere (another folder, a parent path). `.md.md` is read as `.md`.
 */
function linkedName(link: string, folder: string): string | undefined {
  let target = link.replace(/\\/g, '/').replace(/^(\.\/)+/, '');
  if (target.includes('/')) {
    const cut = target.lastIndexOf('/');
    if (keyOf(target.slice(0, cut)) !== keyOf(folder)) return undefined;
    target = target.slice(cut + 1);
  }
  if (!target || target === '.' || target === '..') return undefined;
  return target.replace(/(\.md)+$/i, '.md');
}

/** The chain of one experiment folder. Reads only `folder` itself, never another folder. */
export async function buildChain(
  fs: LabnoteFs,
  folder: string,
  opts: { customTypes?: readonly string[] } = {}
): Promise<ExperimentChain> {
  const dir = folder.replace(/\\/g, '/').replace(/\/+$/, '');
  const issues: ChainIssue[] = [];
  const types = [...SAMPLE_TYPES, ...(opts.customTypes ?? [])];

  let entries: string[] = [];
  try {
    entries = await fs.list(dir);
  } catch (e) {
    issues.push({ code: 'unreadable', path: dir, detail: e instanceof Error ? e.message : String(e) });
  }

  // README
  const readmeName = README_NAMES.map(n => entries.find(e => nameKey(e) === n)).find(Boolean);
  let readmePath: string | undefined;
  let readme: string | undefined;
  if (readmeName) {
    readmePath = `${dir}/${readmeName}`;
    readme = await readCapped(fs, readmePath, issues);
  } else {
    issues.push({ code: 'missingReadme', path: dir });
  }

  // Workflow files, capped.
  let files = entries.filter(e => WORKFLOW_FILE_RE.test(e) && !README_NAMES.includes(nameKey(e))).sort(byNumberThenName);
  if (files.length > MAX_WORKFLOW_FILES) {
    issues.push({ code: 'unreadable', path: dir, detail: 'limit' });
    files = files.slice(0, MAX_WORKFLOW_FILES);
  }
  const byName = new Map(files.map(f => [nameKey(f), f]));

  // Order: checklist entries (exact name, else a legacy file by label), then the rest.
  const placed = new Map<string, { label: string; done: boolean }>();
  if (readme !== undefined) {
    const checklist = parseWorkflowChecklistFromReadme(readme.replace(/\r\n/g, '\n'));
    if (checklist.length === 0) issues.push({ code: 'emptyChecklist', path: readmePath });
    for (const item of checklist) {
      const name = linkedName(item.fileName, dir);
      let file = name === undefined ? undefined : byName.get(nameKey(name));
      if (file === undefined) {
        const wanted = new Set([stemKey(item.title), ...(name ? [stemKey(name)] : [])]);
        file = files.find(f => isLegacyName(f) && !placed.has(f) && wanted.has(stemKey(f)));
      }
      if (file === undefined) {
        issues.push(
          name === undefined
            ? { code: 'brokenLink', detail: item.fileName }
            : { code: 'brokenLink', path: `${dir}/${name}`, detail: item.title }
        );
        continue;
      }
      const seen = placed.get(file);
      if (seen) {
        seen.done = seen.done || item.done;
        issues.push({ code: 'duplicateEntry', path: `${dir}/${file}`, detail: item.title });
        continue;
      }
      placed.set(file, { label: item.title, done: item.done });
    }
  }
  const unlisted = files.filter(f => !placed.has(f));
  const ordered = [...placed.keys(), ...unlisted];

  const workflows: WorkflowNode[] = [];
  for (const fileName of ordered) {
    const path = `${dir}/${fileName}`;
    const entry = placed.get(fileName);
    if (!entry) issues.push({ code: 'unlistedWorkflow', path });
    const md = await readCapped(fs, path, issues);
    const unitOps = md === undefined ? [] : unitOpsOf(md, path, types);
    if (md !== undefined && unitOps.length === 0) issues.push({ code: 'noUnitOps', path });
    workflows.push({
      path,
      fileName,
      label: entry?.label ?? defaultWorkflowTitle(fileName).replace(/\.md$/i, ''),
      listed: entry !== undefined,
      done: entry?.done ?? false,
      legacy: isLegacyName(fileName),
      unitOps,
    });
  }

  // A unit op whose Output names no sample breaks the chain to the next one.
  const all = workflows.flatMap(w => w.unitOps);
  for (let i = 0; i < all.length - 1; i++) {
    if (all[i].outputIds.length === 0) issues.push({ code: 'noOutput', path: all[i].workflowPath, detail: all[i].heading });
  }

  return { folder: dir, readmePath, goal: readme === undefined ? '' : goalOf(readme), workflows, issues };
}
