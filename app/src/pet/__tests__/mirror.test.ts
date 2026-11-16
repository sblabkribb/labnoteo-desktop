import { EMPTY_MIRROR, buildStateEvent, mirrorReduce, type MirrorEvent, type MirrorState } from '../mirror';
import type { AnswerEvent, StateEvent } from '../protocol';

const st = (o: Partial<StateEvent> = {}): StateEvent => ({ v: 1, seq: 1, state: 'idle', skin: 'flasko', scale: 2, busy: false, lang: 'ko', status: '', quiet: false, folder: '', sections: [], unitTarget: '', recent: [], ...o });
const an = (o: Partial<AnswerEvent> = {}): AnswerEvent => ({ v: 1, seq: 2, askId: 'abcd-1234', text: 'Hi', done: true, error: false, ...o });
const run = (s: MirrorState, ...ev: MirrorEvent[]) => ev.reduce(mirrorReduce, s);

describe('mirrorReduce (the pet window)', () => {
  it('starts offline with an idle sprite and no bubble', () => {
    expect(EMPTY_MIRROR).toMatchObject({ state: 'idle', online: false, bubble: null, answer: null, reason: null });
  });
  it('a state snapshot sets state, skin, scale, status and goes online', () => {
    const s = run(EMPTY_MIRROR, { type: 'state', event: st({ seq: 3, state: 'think', busy: true, status: 'Searching' }) });
    expect(s).toMatchObject({ online: true, seq: 3, state: 'think', busy: true, status: 'Searching' });
  });
  it('ignores a snapshot older than or equal to the last one', () => {
    const a = run(EMPTY_MIRROR, { type: 'state', event: st({ seq: 5, state: 'talk' }) });
    expect(run(a, { type: 'state', event: st({ seq: 4, state: 'idle' }) }).state).toBe('talk');
    expect(run(a, { type: 'state', event: st({ seq: 5, state: 'idle' }) }).state).toBe('talk');
  });
  it('after a reset a restarted main window (lower seq) is accepted', () => {
    const a = run(EMPTY_MIRROR, { type: 'state', event: st({ seq: 50 }) });
    expect(run(a, { type: 'reset' }, { type: 'state', event: st({ seq: 1, state: 'think' }) }).state).toBe('think');
  });
  it('a finished answer pops a toast with the latest line unless quiet', () => {
    const a = run(EMPTY_MIRROR, { type: 'answer', event: an({ text: 'Done: 3 notes' }) });
    expect(a.answer).toEqual({ askId: 'abcd-1234', text: 'Done: 3 notes', done: true, error: false });
    expect(a.bubble).toBe('toast');
  });
  it('quiet mode: no bubble pops up by itself', () => {
    expect(run(EMPTY_MIRROR, { type: 'state', event: st({ quiet: true }) }, { type: 'answer', event: an() }).bubble).toBeNull();
  });
  it('a click toggles the panel, replacing a toast; another click closes it', () => {
    const toast = run(EMPTY_MIRROR, { type: 'answer', event: an() });
    const panel = run(toast, { type: 'toggle' });
    expect(panel.bubble).toBe('panel');
    expect(run(panel, { type: 'toggle' }).bubble).toBeNull();
  });
  it('dismissing removes a toast but never a panel', () => {
    const toast = run(EMPTY_MIRROR, { type: 'answer', event: an() });
    expect(run(toast, { type: 'dismissToast' }).bubble).toBeNull();
    expect(run(toast, { type: 'toggle' }, { type: 'dismissToast' }).bubble).toBe('panel');
  });
  it('a reject sets the one reason and ends the pending ask', () => {
    const a = run(EMPTY_MIRROR, { type: 'asked', askId: 'abcd-1234' }, { type: 'reject', event: { v: 1, askId: 'abcd-1234', reason: 'busy' } });
    expect(a).toMatchObject({ reason: 'busy', pendingAsk: null });
  });
  it('ignores a reject for another ask than the pending one', () => {
    const a = run(EMPTY_MIRROR, { type: 'asked', askId: 'abcd-1234' }, { type: 'reject', event: { v: 1, askId: 'zzzz-9999', reason: 'busy' } });
    expect(a).toMatchObject({ reason: null, pendingAsk: 'abcd-1234' });
  });
  it('an unfinished answer keeps the ask pending; the finished one ends it', () => {
    const a = run(EMPTY_MIRROR, { type: 'asked', askId: 'abcd-1234' }, { type: 'answer', event: an({ seq: 1, text: 'partial', done: false }) });
    expect(a.pendingAsk).toBe('abcd-1234');
    expect(run(a, { type: 'answer', event: an({ seq: 2, text: 'full' }) })).toMatchObject({ pendingAsk: null, answer: { text: 'full', done: true } });
  });
  it('an older answer snapshot of the same ask is ignored', () => {
    const a = run(EMPTY_MIRROR, { type: 'asked', askId: 'abcd-1234' }, { type: 'answer', event: an({ seq: 5, text: 'five', done: false }) }, { type: 'answer', event: an({ seq: 4, text: 'four', done: false }) });
    expect(a.answer?.text).toBe('five');
  });
  it('offline while an ask is pending gives the offline reason and releases the ask', () => {
    const a = run(EMPTY_MIRROR, { type: 'state', event: st() }, { type: 'asked', askId: 'abcd-1234' }, { type: 'offline' });
    expect(a).toMatchObject({ online: false, reason: 'offline', pendingAsk: null });
  });
  it('setQuiet drops a toast that is showing', () => {
    const toast = run(EMPTY_MIRROR, { type: 'answer', event: an() });
    expect(run(toast, { type: 'setQuiet', quiet: true })).toMatchObject({ quiet: true, bubble: null });
  });
});

describe('mirror: experiment context and clearing', () => {
  it('a snapshot sets the folder name and the section list', () => {
    const s = run(EMPTY_MIRROR, { type: 'state', event: st({ seq: 2, folder: '001_A', sections: ['Methods'], unitTarget: '001_wf.md' }) });
    expect(s).toMatchObject({ folder: '001_A', sections: ['Methods'], unitTarget: '001_wf.md' });
  });
  it('cleared empties the answer, the reason and a pending question', () => {
    const a = run(EMPTY_MIRROR, { type: 'asked', askId: 'abcd-1234' }, { type: 'answer', event: an({ done: false }) }, { type: 'cleared' });
    expect(a).toMatchObject({ answer: null, pendingAsk: null, reason: null, answerSeq: -1 });
  });
  it('a snapshot replaces the recent conversation; an older one does not; cleared empties it', () => {
    const recent = [{ role: 'user' as const, text: 'q' }, { role: 'assistant' as const, text: 'a' }];
    const s = run(EMPTY_MIRROR, { type: 'state', event: st({ seq: 2, recent }) }, { type: 'state', event: st({ seq: 1 }) });
    expect(s.recent).toEqual(recent); // seq 1 is older: the conversation stays
    expect(run(s, { type: 'state', event: st({ seq: 3, recent: [] }) }).recent).toEqual([]);
    expect(run(s, { type: 'cleared' }).recent).toEqual([]);
  });
});

describe('buildStateEvent (the main window)', () => {
  const pet = { state: 'think' as const, skin: 'flasko', scale: 3 as const };
  it('maps the pet state, busy and the last assistant status line', () => {
    expect(buildStateEvent({ seq: 9, pet, items: [{ role: 'assistant', text: '', status: 'Reading the note' }], streaming: true, lang: 'en', quiet: false })).toEqual({
      v: 1, seq: 9, state: 'think', skin: 'flasko', scale: 3, busy: true, lang: 'en', status: 'Reading the note', quiet: false, folder: '', sections: [], unitTarget: '', recent: [],
    });
  });
  it('bounds the recent conversation: the newest turns, each text clamped, empty turns dropped, the error flag kept', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ role: (i % 2 ? 'assistant' : 'user') as 'user' | 'assistant', text: `t${i}` }));
    const e = buildStateEvent({ seq: 3, pet, items: [], streaming: false, lang: 'en', quiet: false, recent: [...many, { role: 'assistant' as const, text: '' }] });
    expect(e.recent.map((x) => x.text)).toEqual(['t4', 't5', 't6', 't7', 't8', 't9']);
    const long = buildStateEvent({
      seq: 4, pet, items: [], streaming: false, lang: 'en', quiet: false,
      recent: [{ role: 'user', text: 'x'.repeat(9999) }, { role: 'assistant', text: 'ok', error: true }],
    });
    expect([...long.recent[0].text].length).toBeLessThanOrEqual(1200);
    expect(long.recent[1]).toEqual({ role: 'assistant', text: 'ok', error: true });
    expect(buildStateEvent({ seq: 5, pet, items: [], streaming: false, lang: 'en', quiet: false, recent: [{ role: 'user', text: '  ' }] }).recent).toEqual([]);
  });
  it('carries only the experiment folder name, the section labels and the target note name', () => {
    const e = buildStateEvent({
      seq: 1, pet, items: [], streaming: false, lang: 'en', quiet: false,
      folder: 'labnote/001_Cloning', sections: ['Methods', 'Results'], unitTarget: 'labnote/001_Cloning/001_wf.md',
    });
    expect(e).toMatchObject({ folder: '001_Cloning', sections: ['Methods', 'Results'], unitTarget: '001_wf.md' });
    expect(buildStateEvent({ seq: 1, pet, items: [], streaming: false, lang: 'en', quiet: false, folder: null }).folder).toBe('');
  });
  it('bounds a huge status and copes with an empty session', () => {
    expect(buildStateEvent({ seq: 1, pet, items: [], streaming: false, lang: 'ko', quiet: true }).status).toBe('');
    const long = buildStateEvent({ seq: 2, pet, items: [{ role: 'assistant', text: '', status: 'x'.repeat(999) }], streaming: false, lang: 'ko', quiet: false });
    expect([...long.status].length).toBeLessThanOrEqual(120);
  });
});
