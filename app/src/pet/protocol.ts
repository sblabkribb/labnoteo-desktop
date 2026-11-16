import type { ChipId } from '../assistant/chipMeta';
import type { SkinState } from '../assistant/skins/types';

/**
 * Events between the main window and the desktop assistant window (plan D5). Characters: a-z and ':' only.
 *
 * The desktop window draws the assistant panel (Bubble) itself; the conversation, the AI runs, the vault and the history stay
 * in the main window. The main window sends the sprite state (`pet:state`) and the conversation (`pet:chat`); the desktop
 * window asks for things with `pet:call` and gets each answer in `pet:result`. Every payload is checked on arrival: a value
 * that does not match is dropped, never trusted.
 */
export const EVT = {
  state: 'pet:state',
  chat: 'pet:chat',
  result: 'pet:result',
  ready: 'pet:ready',
  call: 'pet:call',
  closed: 'pet:closed',
} as const;

export const STATUS_MAX = 200;
export const TEXT_MAX = 40_000;
export const MESSAGES_MAX = 300;
export const SOURCES_MAX = 60;
export const FIELD_MAX = 2_000;
export const PATH_MAX = 1_000;
export const ARG_TEXT_MAX = 8_000;
export const OPTIONS_MAX = 200;
export const LIST_MAX = 200;

const CHIPS: readonly ChipId[] = ['howTo', 'section', 'unitOp', 'workflow', 'chat'];
const MAKING: readonly ChipId[] = ['section', 'unitOp', 'workflow'];
const STATES: readonly SkinState[] = ['idle', 'talk', 'think', 'done'];
const SOURCE_KINDS = ['note', 'web', 'paper'] as const;
const CALL_ID = /^[A-Za-z0-9-]{8,60}$/;
const ITEM_ID = /^[A-Za-z0-9-]{1,80}$/;
const SKIN_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** The commands the panel runs (connection settings, the experiment list, assistant settings, clear history). Nothing else. */
export const PANEL_COMMANDS = ['app.integration-settings', 'open-workflow-view', 'assistant.settings', 'assistant.clearHistory'] as const;

export interface StateEvent {
  v: 1;
  seq: number;
  state: SkinState;
  skin: string;
  scale: 2 | 3;
  busy: boolean;
  lang: 'ko' | 'en';
  quiet: boolean;
  /** The panel is open (the main window's pet store holds this, so commands such as Ctrl+Shift+Y open it). */
  open: boolean;
  /** The open note (vault-relative), '' when none. */
  activePath: string;
}

export interface WireSource {
  kind: (typeof SOURCE_KINDS)[number];
  label: string;
  target: string;
}

/** One chat item as the panel draws it. `notice` is the end notice already in words (the main window's is a function). */
export interface WireItem {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  sources: WireSource[];
  tainted: boolean;
  pending?: boolean;
  status?: string;
  error?: string;
  errorDetail?: { label: string; text: string };
  notice?: string;
  stopped?: boolean;
}

export interface ChatEvent {
  v: 1;
  seq: number;
  folder: string | null;
  loading: boolean;
  summarised: boolean;
  streaming: boolean;
  notice: string | null;
  chip: ChipId;
  messages: WireItem[];
}

export interface WireSectionOption {
  heading: string;
  parentHeading?: string;
  existing: boolean;
  after?: string;
  planning: boolean;
}

export interface WireChipRun {
  chip: 'section' | 'unitOp' | 'workflow';
  params: Record<string, string>;
  line: string;
  text: string;
}

/** What the desktop window may ask of the main window, with its arguments. */
export type Call =
  | { method: 'send'; args: [string] }
  | { method: 'runChip'; args: [WireChipRun] }
  | { method: 'stop'; args: [] }
  | { method: 'clear'; args: [] }
  | { method: 'setChip'; args: [ChipId] }
  | { method: 'setOpen'; args: [boolean] }
  | { method: 'hide'; args: [] }
  | { method: 'ready'; args: [] }
  | { method: 'sectionChoices'; args: [] }
  | { method: 'workflowNotes'; args: [string] }
  | { method: 'webSearchConfigured'; args: [] }
  | { method: 'runCommand'; args: [(typeof PANEL_COMMANDS)[number]] }
  | { method: 'openSource'; args: [WireSource] }
  | { method: 'insert'; args: [string, boolean] };

export type CallEvent = { v: 1; id: string } & Call;

export interface ResultEvent {
  v: 1;
  id: string;
  ok: boolean;
  value?: unknown;
}

export interface ReadyEvent {
  v: 1;
}

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const isBool = (x: unknown): x is boolean => typeof x === 'boolean';

/** Plain text, bounded: control characters except newline and tab removed, cut at a code point with an ellipsis. */
export function clampText(raw: unknown, max: number): string {
  if (typeof raw !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  const clean = raw.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '');
  const cps = [...clean];
  return cps.length <= max ? clean : cps.slice(0, max - 1).join('') + '…';
}

const line = (raw: unknown, max: number): string => clampText(raw, max).replace(/\s*\n\s*/g, ' ').trim();
const seqOf = (x: unknown): number | null => (typeof x === 'number' && Number.isInteger(x) && x >= 0 && x <= Number.MAX_SAFE_INTEGER ? x : null);
const isChip = (x: unknown): x is ChipId => typeof x === 'string' && (CHIPS as readonly string[]).includes(x);

export function parseState(raw: unknown): StateEvent | null {
  if (!isObj(raw) || raw.v !== 1) return null;
  const seq = seqOf(raw.seq);
  if (seq === null) return null;
  if (typeof raw.state !== 'string' || !STATES.includes(raw.state as SkinState)) return null;
  if (typeof raw.skin !== 'string' || !SKIN_ID.test(raw.skin)) return null;
  if (raw.scale !== 2 && raw.scale !== 3) return null;
  if (!isBool(raw.busy) || !isBool(raw.open)) return null;
  if (raw.lang !== 'ko' && raw.lang !== 'en') return null;
  return {
    v: 1,
    seq,
    state: raw.state as SkinState,
    skin: raw.skin,
    scale: raw.scale,
    busy: raw.busy,
    lang: raw.lang,
    quiet: raw.quiet === true,
    open: raw.open,
    activePath: line(raw.activePath, PATH_MAX),
  };
}

export function parseSource(raw: unknown): WireSource | null {
  if (!isObj(raw) || typeof raw.kind !== 'string' || !(SOURCE_KINDS as readonly string[]).includes(raw.kind)) return null;
  const target = line(raw.target, FIELD_MAX);
  if (!target) return null;
  return { kind: raw.kind as WireSource['kind'], label: line(raw.label, FIELD_MAX), target };
}

function parseItem(raw: unknown): WireItem | null {
  if (!isObj(raw) || typeof raw.id !== 'string' || !ITEM_ID.test(raw.id)) return null;
  if (raw.role !== 'user' && raw.role !== 'assistant') return null;
  const sources = Array.isArray(raw.sources) ? raw.sources.slice(0, SOURCES_MAX).map(parseSource).filter((s): s is WireSource => !!s) : [];
  const item: WireItem = { id: raw.id, role: raw.role, text: clampText(raw.text, TEXT_MAX), sources, tainted: raw.tainted === true };
  if (raw.pending === true) item.pending = true;
  if (raw.stopped === true) item.stopped = true;
  const status = line(raw.status, STATUS_MAX);
  if (status) item.status = status;
  const error = clampText(raw.error, FIELD_MAX).trim();
  if (error) item.error = error;
  const notice = clampText(raw.notice, FIELD_MAX).trim();
  if (notice) item.notice = notice;
  if (isObj(raw.errorDetail)) {
    const label = line(raw.errorDetail.label, STATUS_MAX);
    const text = clampText(raw.errorDetail.text, TEXT_MAX);
    if (label && text) item.errorDetail = { label, text };
  }
  return item;
}

export function parseChat(raw: unknown): ChatEvent | null {
  if (!isObj(raw) || raw.v !== 1) return null;
  const seq = seqOf(raw.seq);
  if (seq === null || !isChip(raw.chip) || !Array.isArray(raw.messages)) return null;
  if (!isBool(raw.loading) || !isBool(raw.summarised) || !isBool(raw.streaming)) return null;
  const folder = raw.folder === null ? null : line(raw.folder, PATH_MAX) || null;
  const notice = typeof raw.notice === 'string' ? clampText(raw.notice, FIELD_MAX).trim() || null : null;
  const messages = raw.messages.slice(-MESSAGES_MAX).map(parseItem).filter((m): m is WireItem => !!m);
  return { v: 1, seq, folder, loading: raw.loading, summarised: raw.summarised, streaming: raw.streaming, notice, chip: raw.chip, messages };
}

function parseChipRun(raw: unknown): WireChipRun | null {
  if (!isObj(raw) || !isChip(raw.chip) || !MAKING.includes(raw.chip) || !isObj(raw.params)) return null;
  const params: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw.params).slice(0, 10)) {
    if (!/^[A-Za-z]{1,30}$/.test(k) || typeof v !== 'string') return null;
    params[k] = line(v, PATH_MAX);
  }
  return { chip: raw.chip as WireChipRun['chip'], params, line: clampText(raw.line, ARG_TEXT_MAX), text: clampText(raw.text, ARG_TEXT_MAX) };
}

/** Main side: a call from the desktop window, or null when anything about it is off. */
export function parseCall(raw: unknown): CallEvent | null {
  if (!isObj(raw) || raw.v !== 1 || typeof raw.id !== 'string' || !CALL_ID.test(raw.id) || typeof raw.method !== 'string') return null;
  const id = raw.id;
  const a = Array.isArray(raw.args) ? raw.args : [];
  switch (raw.method) {
    case 'send': {
      const text = clampText(a[0], ARG_TEXT_MAX).trim();
      return text ? { v: 1, id, method: 'send', args: [text] } : null;
    }
    case 'runChip': {
      const run = parseChipRun(a[0]);
      return run ? { v: 1, id, method: 'runChip', args: [run] } : null;
    }
    case 'setChip':
      return isChip(a[0]) ? { v: 1, id, method: 'setChip', args: [a[0]] } : null;
    case 'setOpen':
      return isBool(a[0]) ? { v: 1, id, method: 'setOpen', args: [a[0]] } : null;
    case 'workflowNotes': {
      const folder = line(a[0], PATH_MAX);
      return folder ? { v: 1, id, method: 'workflowNotes', args: [folder] } : null;
    }
    case 'runCommand':
      return typeof a[0] === 'string' && (PANEL_COMMANDS as readonly string[]).includes(a[0])
        ? { v: 1, id, method: 'runCommand', args: [a[0] as (typeof PANEL_COMMANDS)[number]] }
        : null;
    case 'openSource': {
      const src = parseSource(a[0]);
      return src ? { v: 1, id, method: 'openSource', args: [src] } : null;
    }
    case 'insert': {
      const text = clampText(a[0], TEXT_MAX);
      return text.trim() && isBool(a[1]) ? { v: 1, id, method: 'insert', args: [text, a[1]] } : null;
    }
    case 'stop':
    case 'clear':
    case 'hide':
    case 'ready':
    case 'sectionChoices':
    case 'webSearchConfigured':
      return { v: 1, id, method: raw.method, args: [] };
    default:
      return null;
  }
}

export function parseResult(raw: unknown): ResultEvent | null {
  if (!isObj(raw) || raw.v !== 1 || typeof raw.id !== 'string' || !CALL_ID.test(raw.id) || !isBool(raw.ok)) return null;
  return { v: 1, id: raw.id, ok: raw.ok, ...('value' in raw ? { value: raw.value } : {}) };
}

/** Pet side: the section list from a `sectionChoices` result, bounded; undefined when there is no open note or it is off. */
export function parseSectionChoices(raw: unknown): { path: string; options: WireSectionOption[] } | undefined {
  if (!isObj(raw) || !Array.isArray(raw.options)) return undefined;
  const path = line(raw.path, PATH_MAX);
  if (!path) return undefined;
  const options: WireSectionOption[] = [];
  for (const o of raw.options.slice(0, OPTIONS_MAX)) {
    if (!isObj(o) || !isBool(o.existing) || !isBool(o.planning)) continue;
    const heading = line(o.heading, FIELD_MAX);
    if (!heading) continue;
    const parentHeading = line(o.parentHeading, FIELD_MAX);
    const after = line(o.after, FIELD_MAX);
    options.push({ heading, existing: o.existing, planning: o.planning, ...(parentHeading ? { parentHeading } : {}), ...(after ? { after } : {}) });
  }
  return { path, options };
}

/** Pet side: a list of vault-relative paths from a `workflowNotes` result. */
export function parsePathList(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.slice(0, LIST_MAX).map((p) => line(p, PATH_MAX)).filter(Boolean) : [];
}

export const parseReady = (raw: unknown): ReadyEvent | null => (isObj(raw) && raw.v === 1 ? { v: 1 } : null);
