import type { SkinState } from '../assistant/skins/types';
import { clampText, FOLDER_MAX, LABEL_MAX, RECENT_MAX, RECENT_TEXT_MAX, SECTIONS_MAX, STATUS_MAX, type AnswerEvent, type RecentItem, type RejectEvent, type RejectReason, type StateEvent } from './protocol';

export type BubbleMode = 'toast' | 'panel' | null;

export interface MirrorState {
  online: boolean;
  seq: number;
  state: SkinState;
  skin: string;
  scale: 2 | 3;
  busy: boolean;
  lang: 'ko' | 'en';
  status: string;
  quiet: boolean;
  folder: string;
  sections: string[];
  unitTarget: string;
  /** The recent turns mirrored from the main window (the in-window chat, a bounded slice). */
  recent: RecentItem[];
  bubble: BubbleMode;
  answer: { askId: string; text: string; done: boolean; error: boolean } | null;
  answerSeq: number;
  pendingAsk: string | null;
  reason: RejectReason | 'offline' | null;
}

export const EMPTY_MIRROR: MirrorState = {
  online: false, seq: -1, state: 'idle', skin: 'flasko', scale: 2, busy: false, lang: 'ko', status: '', quiet: false, folder: '', sections: [], unitTarget: '',
  recent: [],
  bubble: null, answer: null, answerSeq: -1, pendingAsk: null, reason: null,
};

export type MirrorEvent =
  | { type: 'state'; event: StateEvent }
  | { type: 'answer'; event: AnswerEvent }
  | { type: 'reject'; event: RejectEvent }
  | { type: 'asked'; askId: string }
  | { type: 'cleared' }
  | { type: 'toggle' }
  | { type: 'dismissToast' }
  | { type: 'offline' }
  | { type: 'reset' }
  | { type: 'setQuiet'; quiet: boolean };

/** The pet window's whole state, from validated events only. Pure. */
export function mirrorReduce(s: MirrorState, e: MirrorEvent): MirrorState {
  switch (e.type) {
    case 'reset':
      return { ...EMPTY_MIRROR, quiet: s.quiet, skin: s.skin, scale: s.scale, lang: s.lang };
    case 'state': {
      if (e.event.seq <= s.seq) return s;
      const { state, skin, scale, busy, lang, status, quiet, folder, sections, unitTarget, recent } = e.event;
      return { ...s, online: true, seq: e.event.seq, state, skin, scale, busy, lang, status, quiet, folder, sections, unitTarget, recent, reason: s.reason === 'offline' ? null : s.reason };
    }
    case 'answer': {
      const a = e.event;
      const mine = s.pendingAsk === a.askId;
      if (s.pendingAsk !== null && !mine) return s; // the reply to another question
      if (a.askId === s.answer?.askId && a.seq <= s.answerSeq) return s;
      const pendingAsk = mine && a.done ? null : s.pendingAsk;
      // A finished answer pops a short bubble by itself, unless quiet or a panel is already open.
      const bubble: BubbleMode = s.bubble === 'panel' ? 'panel' : a.done && !s.quiet ? 'toast' : s.bubble;
      return { ...s, answer: { askId: a.askId, text: a.text, done: a.done, error: a.error }, answerSeq: a.seq, pendingAsk, reason: null, bubble };
    }
    case 'reject':
      return s.pendingAsk === e.event.askId ? { ...s, pendingAsk: null, reason: e.event.reason } : s;
    case 'asked':
      return { ...s, pendingAsk: e.askId, reason: null, answer: null, answerSeq: -1 };
    case 'cleared':
      return { ...s, answer: null, answerSeq: -1, pendingAsk: null, reason: null, recent: [] };
    case 'toggle':
      return { ...s, bubble: s.bubble === 'panel' ? null : 'panel' };
    case 'dismissToast':
      return s.bubble === 'toast' ? { ...s, bubble: null } : s;
    case 'offline':
      return { ...s, online: false, pendingAsk: null, reason: s.pendingAsk ? 'offline' : s.reason };
    case 'setQuiet':
      return { ...s, quiet: e.quiet, bubble: e.quiet && s.bubble === 'toast' ? null : s.bubble };
  }
}

export interface MirrorSource {
  seq: number;
  pet: { state: SkinState; skin: string; scale: 2 | 3 };
  items: Array<{ role: 'user' | 'assistant'; text: string; status?: string }>;
  streaming: boolean;
  lang: 'ko' | 'en';
  quiet: boolean;
  /** Open experiment folder path, or null. Only its last segment leaves the main window. */
  folder?: string | null;
  sections?: string[];
  /** Path of the workflow note the unit operation mode would use. Only its file name leaves. */
  unitTarget?: string;
  /** The recent turns the pet's log shows (text already trimmed to visible lines; bounded again here). */
  recent?: RecentItem[];
}

const basename = (p: string): string => p.split('/').filter(Boolean).pop() ?? p;

/**
 * The main window's snapshot for the pet: the sprite state, the current status line, the experiment context and a bounded slice of
 * the recent conversation — the only conversation text that leaves the main window (the full answer rides `pet:answer` while a run
 * is going). Note text itself (beyond the section labels) never leaves.
 */
export function buildStateEvent(src: MirrorSource): StateEvent {
  const last = [...src.items].reverse().find((i) => i.role === 'assistant');
  return {
    v: 1, seq: src.seq, state: src.pet.state, skin: src.pet.skin, scale: src.pet.scale, busy: src.streaming, lang: src.lang,
    status: clampText(last?.status ?? '', STATUS_MAX), quiet: src.quiet,
    folder: src.folder ? clampText(basename(src.folder), FOLDER_MAX) : '',
    sections: (src.sections ?? []).slice(0, SECTIONS_MAX).map((x) => clampText(x, LABEL_MAX)),
    unitTarget: src.unitTarget ? clampText(basename(src.unitTarget), LABEL_MAX) : '',
    recent: (src.recent ?? [])
      .map((x) => ({ role: x.role, text: clampText(x.text, RECENT_TEXT_MAX), ...(x.error ? { error: true } : {}) }))
      .filter((x) => x.text !== '')
      .slice(-RECENT_MAX),
  };
}
