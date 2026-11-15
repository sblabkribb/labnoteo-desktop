import type { SkinState } from '../assistant/skins/types';

/** Events between the main window and the desktop pet window (plan D5). Characters: a-z and ':' only. */
export const EVT = {
  state: 'pet:state',
  answer: 'pet:answer',
  reject: 'pet:reject',
  ready: 'pet:ready',
  ask: 'pet:ask',
  closed: 'pet:closed',
} as const;

export const STATUS_MAX = 120;
export const ANSWER_MAX = 1200;
export const ASK_MAX = 500;

const STATES: readonly SkinState[] = ['idle', 'talk', 'think', 'done'];
const REASONS = ['no-vault', 'not-configured', 'busy', 'invalid'] as const;
export type RejectReason = (typeof REASONS)[number];
const ASK_ID = /^[A-Za-z0-9-]{8,40}$/;
const SKIN_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

export interface StateEvent {
  v: 1;
  seq: number;
  state: SkinState;
  skin: string;
  scale: 2 | 3;
  busy: boolean;
  lang: 'ko' | 'en';
  status: string;
  quiet: boolean;
}
export interface AnswerEvent {
  v: 1;
  seq: number;
  askId: string;
  text: string;
  done: boolean;
  error: boolean;
}
export interface RejectEvent {
  v: 1;
  askId: string;
  reason: RejectReason;
}
export interface AskEvent {
  v: 1;
  askId: string;
  text: string;
}
export interface ReadyEvent {
  v: 1;
}

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);

/** Plain text, bounded: control characters except newline removed, trimmed, cut at a code point with an ellipsis. */
export function clampText(raw: unknown, max: number): string {
  if (typeof raw !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  const clean = raw.replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, '').trim();
  const cps = [...clean];
  return cps.length <= max ? clean : cps.slice(0, max - 1).join('').trimEnd() + '\u2026';
}

const seqOf = (x: unknown): number | null => (typeof x === 'number' && Number.isInteger(x) && x >= 0 && x <= Number.MAX_SAFE_INTEGER ? x : null);

export function parseState(raw: unknown): StateEvent | null {
  if (!isObj(raw) || raw.v !== 1) return null;
  const seq = seqOf(raw.seq);
  if (seq === null) return null;
  if (typeof raw.state !== 'string' || !STATES.includes(raw.state as SkinState)) return null;
  if (typeof raw.skin !== 'string' || !SKIN_ID.test(raw.skin)) return null;
  if (raw.scale !== 2 && raw.scale !== 3) return null;
  if (typeof raw.busy !== 'boolean') return null;
  if (raw.lang !== 'ko' && raw.lang !== 'en') return null;
  return {
    v: 1,
    seq,
    state: raw.state as SkinState,
    skin: raw.skin,
    scale: raw.scale,
    busy: raw.busy,
    lang: raw.lang,
    status: clampText(raw.status, STATUS_MAX),
    quiet: raw.quiet === true,
  };
}

export function parseAnswer(raw: unknown): AnswerEvent | null {
  if (!isObj(raw) || raw.v !== 1) return null;
  const seq = seqOf(raw.seq);
  if (seq === null || typeof raw.askId !== 'string' || !ASK_ID.test(raw.askId) || typeof raw.text !== 'string') return null;
  return { v: 1, seq, askId: raw.askId, text: clampText(raw.text, ANSWER_MAX), done: raw.done === true, error: raw.error === true };
}

export function parseReject(raw: unknown): RejectEvent | null {
  if (!isObj(raw) || raw.v !== 1 || typeof raw.askId !== 'string' || !ASK_ID.test(raw.askId)) return null;
  return typeof raw.reason === 'string' && (REASONS as readonly string[]).includes(raw.reason) ? { v: 1, askId: raw.askId, reason: raw.reason as RejectReason } : null;
}

export const parseReady = (raw: unknown): ReadyEvent | null => (isObj(raw) && raw.v === 1 ? { v: 1 } : null);

export function parseAsk(raw: unknown): AskEvent | null {
  if (!isObj(raw) || raw.v !== 1 || typeof raw.askId !== 'string' || !ASK_ID.test(raw.askId)) return null;
  const text = clampText(raw.text, ASK_MAX);
  return text ? { v: 1, askId: raw.askId, text } : null;
}

/** Pet side: the event to send for what the person typed, or null when there is nothing to send. */
export function buildAsk(text: string, newId: () => string): AskEvent | null {
  const clean = clampText(text, ASK_MAX);
  return clean ? { v: 1, askId: newId(), text: clean } : null;
}
