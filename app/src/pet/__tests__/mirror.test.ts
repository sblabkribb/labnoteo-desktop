import { EMPTY_MIRROR, buildStateEvent, mirrorReduce, type MirrorEvent, type MirrorState } from '../mirror';
import type { AnswerEvent, StateEvent } from '../protocol';

const st = (o: Partial<StateEvent> = {}): StateEvent => ({ v: 1, seq: 1, state: 'idle', skin: 'flasko', scale: 2, busy: false, lang: 'ko', status: '', quiet: false, ...o });
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

describe('buildStateEvent (the main window)', () => {
  const pet = { state: 'think' as const, skin: 'flasko', scale: 3 as const };
  it('maps the pet state, busy and the last assistant status line', () => {
    expect(buildStateEvent({ seq: 9, pet, items: [{ role: 'assistant', text: '', status: 'Reading the note' }], streaming: true, lang: 'en', quiet: false })).toEqual({
      v: 1, seq: 9, state: 'think', skin: 'flasko', scale: 3, busy: true, lang: 'en', status: 'Reading the note', quiet: false,
    });
  });
  it('bounds a huge status and copes with an empty session', () => {
    expect(buildStateEvent({ seq: 1, pet, items: [], streaming: false, lang: 'ko', quiet: true }).status).toBe('');
    const long = buildStateEvent({ seq: 2, pet, items: [{ role: 'assistant', text: '', status: 'x'.repeat(999) }], streaming: false, lang: 'ko', quiet: false });
    expect([...long.status].length).toBeLessThanOrEqual(120);
  });
});
