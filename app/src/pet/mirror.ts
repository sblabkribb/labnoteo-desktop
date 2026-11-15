import type { SkinState } from '../assistant/skins/types';
import { clampText, STATUS_MAX, type AnswerEvent, type RejectEvent, type RejectReason, type StateEvent } from './protocol';

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
  bubble: BubbleMode;
  answer: { askId: string; text: string; done: boolean; error: boolean } | null;
  answerSeq: number;
  pendingAsk: string | null;
  reason: RejectReason | 'offline' | null;
}

export const EMPTY_MIRROR: MirrorState = {
  online: false, seq: -1, state: 'idle', skin: 'flasko', scale: 2, busy: false, lang: 'ko', status: '', quiet: false,
  bubble: null, answer: null, answerSeq: -1, pendingAsk: null, reason: null,
};

export type MirrorEvent =
  | { type: 'state'; event: StateEvent }
  | { type: 'answer'; event: AnswerEvent }
  | { type: 'reject'; event: RejectEvent }
  | { type: 'asked'; askId: string }
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
      const { state, skin, scale, busy, lang, status, quiet } = e.event;
      return { ...s, online: true, seq: e.event.seq, state, skin, scale, busy, lang, status, quiet, reason: s.reason === 'offline' ? null : s.reason };
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
}

/** The main window's snapshot for the pet: only the sprite state and the current status line, never vault data. */
export function buildStateEvent(src: MirrorSource): StateEvent {
  const last = [...src.items].reverse().find((i) => i.role === 'assistant');
  return {
    v: 1, seq: src.seq, state: src.pet.state, skin: src.pet.skin, scale: src.pet.scale, busy: src.streaming, lang: src.lang,
    status: clampText(last?.status ?? '', STATUS_MAX), quiet: src.quiet,
  };
}
