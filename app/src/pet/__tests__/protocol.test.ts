import { ANSWER_MAX, ASK_MAX, EVT, MODES, STATUS_MAX, buildAsk, parseClear, clampText, parseAnswer, parseAsk, parseReady, parseReject, parseState } from '../protocol';

const state = { v: 1, seq: 1, state: 'think', skin: 'flasko', scale: 2, busy: true, lang: 'en', status: 'Searching notes', quiet: false };

describe('event names', () => {
  it('are fixed and use only characters Tauri allows', () => {
    expect(Object.values(EVT).sort()).toEqual(['pet:answer', 'pet:ask', 'pet:clear', 'pet:closed', 'pet:ready', 'pet:reject', 'pet:state']);
    for (const n of Object.values(EVT)) expect(n).toMatch(/^[a-z:]+$/);
  });
});

describe('clampText', () => {
  it('trims and removes control characters except newline', () => {
    expect(clampText('  hi\u0000 there\u0007\n', 20)).toBe('hi there');
  });
  it('truncates at a code point with an ellipsis and never splits a surrogate pair', () => {
    const out = clampText('a'.repeat(9) + '\u{1F600}' + 'b'.repeat(5), 10);
    expect([...out].length).toBeLessThanOrEqual(10);
    expect(out.endsWith('\u2026')).toBe(true);
    expect(out).not.toMatch(/[\uD800-\uDBFF]$/);
  });
  it('returns an empty string for non-strings', () => {
    expect(clampText(42, 5)).toBe('');
  });
});

describe('parseState', () => {
  it('accepts a good snapshot', () => {
    expect(parseState(state)).toMatchObject({ seq: 1, state: 'think', skin: 'flasko', scale: 2, busy: true, lang: 'en', status: 'Searching notes' });
  });
  it.each([
    ['not an object', 'x'],
    ['null', null],
    ['an array', []],
    ['wrong version', { ...state, v: 2 }],
    ['unknown state', { ...state, state: 'error' }],
    ['bad skin id', { ...state, skin: '../x' }],
    ['scale 4', { ...state, scale: 4 }],
    ['negative seq', { ...state, seq: -1 }],
    ['non-integer seq', { ...state, seq: 1.5 }],
    ['busy not a bool', { ...state, busy: 'yes' }],
    ['unknown lang', { ...state, lang: 'fr' }],
  ])('rejects %s', (_n, v) => expect(parseState(v)).toBeNull());
  it('truncates an oversize status instead of trusting it', () => {
    expect([...(parseState({ ...state, status: 'x'.repeat(5000) })?.status ?? '')].length).toBeLessThanOrEqual(STATUS_MAX);
  });
  it('keeps HTML-looking text as literal text (it is only ever rendered as a text node)', () => {
    expect(parseState({ ...state, status: '<img src=x onerror=alert(1)>' })?.status).toBe('<img src=x onerror=alert(1)>');
  });
});

describe('parseAnswer', () => {
  const a = { v: 1, seq: 4, askId: 'abcd-1234', text: 'Hello', done: false, error: false };
  it('accepts a snapshot and bounds the text', () => {
    expect(parseAnswer(a)).toMatchObject({ askId: 'abcd-1234', text: 'Hello', done: false, error: false });
    expect([...(parseAnswer({ ...a, text: 'y'.repeat(9999) })?.text ?? '')].length).toBeLessThanOrEqual(ANSWER_MAX);
  });
  it.each([
    ['bad id', { ...a, askId: 'a b' }],
    ['short id', { ...a, askId: 'abc' }],
    ['no seq', { ...a, seq: undefined }],
    ['text not a string', { ...a, text: 5 }],
  ])('rejects %s', (_n, v) => expect(parseAnswer(v)).toBeNull());
});

describe('parseReject and parseReady', () => {
  it('accepts only the known reason codes', () => {
    for (const reason of ['no-vault', 'not-configured', 'busy', 'invalid', 'no-note', 'no-workflow']) expect(parseReject({ v: 1, askId: 'abcd-1234', reason })?.reason).toBe(reason);
    expect(parseReject({ v: 1, askId: 'abcd-1234', reason: 'because I said so' })).toBeNull();
  });
  it('ready is just {v:1}', () => {
    expect(parseReady({ v: 1 })).toEqual({ v: 1 });
    expect(parseReady({ v: 2 })).toBeNull();
  });
});

describe('ask (pet to main)', () => {
  it('buildAsk trims, bounds and refuses empty text', () => {
    expect(buildAsk('   ', () => 'abcd-1234')).toBeNull();
    expect(buildAsk('  What is a DAG?  ', () => 'abcd-1234')).toEqual({ v: 1, askId: 'abcd-1234', mode: 'chat', text: 'What is a DAG?' });
    expect([...(buildAsk('z'.repeat(9000), () => 'abcd-1234')?.text ?? '')].length).toBeLessThanOrEqual(ASK_MAX);
  });
  it('parseAsk (main side) validates everything again', () => {
    expect(parseAsk({ v: 1, askId: 'abcd-1234', text: 'ok' })).toEqual({ v: 1, askId: 'abcd-1234', mode: 'chat', text: 'ok' });
    expect(parseAsk({ v: 1, askId: 'abcd-1234', text: '   ' })).toBeNull();
    expect(parseAsk({ v: 1, askId: '../..', text: 'ok' })).toBeNull();
    expect(parseAsk({ v: 1, askId: 'abcd-1234', text: 7 })).toBeNull();
    expect([...(parseAsk({ v: 1, askId: 'abcd-1234', text: 'z'.repeat(9000) })?.text ?? '')].length).toBeLessThanOrEqual(ASK_MAX);
  });
});

describe('modes', () => {
  it('are the five panel modes, in the panel order', () => {
    expect([...MODES]).toEqual(['howTo', 'section', 'unitOp', 'workflow', 'chat']);
  });
  const ask = (o: Record<string, unknown> = {}) => ({ v: 1, askId: 'abcd-1234', text: 'ok', ...o });
  it('parseAsk keeps a known mode and refuses anything else (an enum, never free text)', () => {
    for (const mode of MODES) expect(parseAsk(ask({ mode, section: { kind: 'new', title: 'T' } }))?.mode).toBe(mode);
    expect(parseAsk(ask({ mode: 'rm -rf' }))).toBeNull();
    expect(parseAsk(ask({ mode: 7 }))).toBeNull();
    expect(parseAsk(ask({ mode: 'toString' }))).toBeNull();
  });
  it('unit operation, workflow and chat need text; a section needs a pick but may have no text', () => {
    for (const mode of ['unitOp', 'workflow', 'chat']) expect(parseAsk(ask({ mode, text: '  ' }))).toBeNull();
    expect(parseAsk(ask({ mode: 'section', text: '' }))).toBeNull();
    expect(parseAsk(ask({ mode: 'section', text: '', section: { kind: 'pick', index: 2, label: 'Methods' } }))?.section).toEqual({ kind: 'pick', index: 2, label: 'Methods' });
    expect(parseAsk(ask({ mode: 'section', text: '', section: { kind: 'new', title: ' Results  ' } }))?.section).toEqual({ kind: 'new', title: 'Results' });
  });
  it('a bad section pick is refused', () => {
    for (const section of [{ kind: 'pick', index: -1, label: 'a' }, { kind: 'pick', index: 1.5, label: 'a' }, { kind: 'pick', index: 99999, label: 'a' }, { kind: 'pick', index: 1 }, { kind: 'new', title: '  ' }, { kind: 'other' }, 'x'])
      expect(parseAsk(ask({ mode: 'section', section })), JSON.stringify(section)).toBeNull();
  });
  it('a new section title is one bounded line', () => {
    const t = parseAsk(ask({ mode: 'section', text: '', section: { kind: 'new', title: 'a\nb' + 'z'.repeat(999) } }));
    expect(t?.section && 'title' in t.section ? t.section.title : '').not.toMatch(/\n/);
    expect([...(t?.section && 'title' in t.section ? t.section.title : '')].length).toBeLessThanOrEqual(200);
  });
  it('buildAsk carries the mode and the pick, and has nothing to send for how-to', () => {
    expect(buildAsk('go', () => 'abcd-1234', 'workflow')).toEqual({ v: 1, askId: 'abcd-1234', mode: 'workflow', text: 'go' });
    expect(buildAsk('go', () => 'abcd-1234', 'howTo')).toBeNull();
    expect(buildAsk('', () => 'abcd-1234', 'section')).toBeNull();
    expect(buildAsk('', () => 'abcd-1234', 'section', { kind: 'pick', index: 0, label: 'Methods' })).toEqual({ v: 1, askId: 'abcd-1234', mode: 'section', text: '', section: { kind: 'pick', index: 0, label: 'Methods' } });
  });
});

describe('state: experiment name and section list', () => {
  it('are bounded plain text, missing means none', () => {
    expect(parseState(state)).toMatchObject({ folder: '', sections: [], unitTarget: '' });
    const s = parseState({ ...state, folder: 'f'.repeat(999), sections: ['A', 7, 'b'.repeat(999), ...Array(60).fill('x')], unitTarget: '001_wf.md' });
    expect([...(s?.folder ?? '')].length).toBeLessThanOrEqual(80);
    expect(s?.sections.length).toBe(40);
    expect(s?.sections[0]).toBe('A');
    expect(s?.sections.every((x) => [...x].length <= 100)).toBe(true);
    expect(s?.unitTarget).toBe('001_wf.md');
    expect(parseState({ ...state, sections: 'nope' })?.sections).toEqual([]);
  });
});

describe('clear (pet to main)', () => {
  it('is just {v:1}', () => {
    expect(parseClear({ v: 1 })).toEqual({ v: 1 });
    expect(parseClear({ v: 2 })).toBeNull();
    expect(parseClear(null)).toBeNull();
  });
});
