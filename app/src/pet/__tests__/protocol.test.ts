import { describe, expect, it } from 'vitest';
import {
  FIELD_MAX,
  MESSAGES_MAX,
  PANEL_COMMANDS,
  parseCall,
  parseChat,
  parsePathList,
  parseResult,
  parseSectionChoices,
  parseState,
  TEXT_MAX,
} from '../protocol';

const state = { v: 1, seq: 3, state: 'idle', skin: 'flasko', scale: 2, busy: false, lang: 'ko', quiet: false, open: true, activePath: 'labnote/001_A/README.md' };
const chat = { v: 1, seq: 4, folder: 'labnote/001_A', loading: false, summarised: false, streaming: false, notice: null, chip: 'chat', messages: [] as unknown[] };
const ID = 'call-00000001';

describe('parseState', () => {
  it('accepts a valid snapshot and keeps open and the open note', () => {
    expect(parseState(state)).toEqual({ ...state });
  });
  it('rejects a wrong version, state, skin id, scale, language or a missing open flag', () => {
    for (const bad of [{ v: 2 }, { state: 'error' }, { skin: '../x' }, { scale: 4 }, { lang: 'fr' }, { open: 'yes' }, { seq: -1 }]) {
      expect(parseState({ ...state, ...bad }), JSON.stringify(bad)).toBeNull();
    }
    expect(parseState(null)).toBeNull();
  });
});

describe('parseChat', () => {
  it('keeps the drawn fields of each item and drops what does not fit', () => {
    const ev = parseChat({
      ...chat,
      messages: [
        { id: 'a-1', role: 'assistant', text: 'hi', sources: [{ kind: 'web', label: 'L', target: 'https://x.org' }, { kind: 'ftp', label: 'x', target: 'y' }], tainted: true, notice: 'Changed 1 note.', status: 'Reading', pending: true },
        { id: 'bad id!', role: 'user', text: 'x' },
        { id: 'u-1', role: 'robot', text: 'x' },
        7,
      ],
    })!;
    expect(ev.messages).toEqual([
      { id: 'a-1', role: 'assistant', text: 'hi', sources: [{ kind: 'web', label: 'L', target: 'https://x.org' }], tainted: true, notice: 'Changed 1 note.', status: 'Reading', pending: true },
    ]);
  });
  it('bounds the item count and each text', () => {
    const many = Array.from({ length: MESSAGES_MAX + 20 }, (_, i) => ({ id: `m-${i}`, role: 'user', text: i === MESSAGES_MAX + 19 ? 'y'.repeat(TEXT_MAX + 50) : 't' }));
    const ev = parseChat({ ...chat, messages: many })!;
    expect(ev.messages).toHaveLength(MESSAGES_MAX);
    expect(ev.messages[0].id).toBe('m-20');
    expect([...ev.messages.at(-1)!.text].length).toBeLessThanOrEqual(TEXT_MAX);
  });
  it('rejects an unknown chip or a missing flag; a null folder stays null', () => {
    expect(parseChat({ ...chat, chip: 'admin' })).toBeNull();
    expect(parseChat({ ...chat, streaming: 'no' })).toBeNull();
    expect(parseChat({ ...chat, folder: null })?.folder).toBeNull();
  });
});

describe('parseCall (main side)', () => {
  it('accepts each method with its arguments', () => {
    expect(parseCall({ v: 1, id: ID, method: 'send', args: [' hi '] })).toEqual({ v: 1, id: ID, method: 'send', args: ['hi'] });
    expect(parseCall({ v: 1, id: ID, method: 'setChip', args: ['unitOp'] })?.args).toEqual(['unitOp']);
    expect(parseCall({ v: 1, id: ID, method: 'setOpen', args: [false] })?.args).toEqual([false]);
    expect(parseCall({ v: 1, id: ID, method: 'insert', args: ['text', true] })?.args).toEqual(['text', true]);
    expect(parseCall({ v: 1, id: ID, method: 'openSource', args: [{ kind: 'note', label: 'R', target: 'labnote/a.md' }] })?.args).toEqual([{ kind: 'note', label: 'R', target: 'labnote/a.md' }]);
    expect(parseCall({ v: 1, id: ID, method: 'runChip', args: [{ chip: 'section', params: { documentPath: 'a.md', heading: 'Goal' }, line: 'Goal', text: '' }] })?.args[0]).toEqual({
      chip: 'section',
      params: { documentPath: 'a.md', heading: 'Goal' },
      line: 'Goal',
      text: '',
    });
    for (const m of ['stop', 'clear', 'hide', 'ready', 'sectionChoices', 'webSearchConfigured']) expect(parseCall({ v: 1, id: ID, method: m })?.method).toBe(m);
    for (const c of PANEL_COMMANDS) expect(parseCall({ v: 1, id: ID, method: 'runCommand', args: [c] })?.args).toEqual([c]);
  });
  it('refuses anything else', () => {
    for (const bad of [
      { v: 1, id: ID, method: 'runCommand', args: ['vault.delete'] },
      { v: 1, id: ID, method: 'eval', args: [] },
      { v: 1, id: ID, method: 'send', args: ['   '] },
      { v: 1, id: ID, method: 'setChip', args: ['admin'] },
      { v: 1, id: ID, method: 'insert', args: ['x', 'yes'] },
      { v: 1, id: ID, method: 'runChip', args: [{ chip: 'chat', params: {}, line: '', text: '' }] },
      { v: 1, id: ID, method: 'runChip', args: [{ chip: 'section', params: { 'bad key': 'x' }, line: '', text: '' }] },
      { v: 1, id: ID, method: 'openSource', args: [{ kind: 'file', label: 'x', target: 'C:/x' }] },
      { v: 1, id: 'short', method: 'stop' },
      { v: 2, id: ID, method: 'stop' },
    ]) {
      expect(parseCall(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe('results (pet side)', () => {
  it('parseResult needs a call id and an ok flag', () => {
    expect(parseResult({ v: 1, id: ID, ok: true, value: 3 })).toEqual({ v: 1, id: ID, ok: true, value: 3 });
    expect(parseResult({ v: 1, id: ID })).toBeNull();
  });
  it('section choices and path lists are bounded and checked', () => {
    expect(parseSectionChoices({ path: 'a.md', options: [{ heading: 'Goal', existing: true, planning: false }, { heading: '', existing: true, planning: false }, { heading: 'x' }] })).toEqual({
      path: 'a.md',
      options: [{ heading: 'Goal', existing: true, planning: false }],
    });
    expect(parseSectionChoices(null)).toBeUndefined();
    expect(parsePathList(['a.md', 3, '', 'b'.repeat(FIELD_MAX)])).toHaveLength(2);
    expect(parsePathList('x')).toEqual([]);
  });
});
