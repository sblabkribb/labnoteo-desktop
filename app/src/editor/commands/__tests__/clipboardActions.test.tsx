// @vitest-environment jsdom
import { act } from '@testing-library/react';
import { undo } from '@codemirror/commands';
import { setLang } from '../../../i18n/lang';
import { t } from '../../../i18n/t';
import { createTestHost, type TestHost } from '../../../labnote/__tests__/testHost';
import { copySelection, cutSelection, pasteClipboard, selectAllIn, type ClipboardLike } from '../clipboardActions';

let h: TestHost;

beforeEach(() => setLang('ko'));
afterEach(() => h?.cleanup());

async function open(text: string) {
  h = createTestHost({ 'notes/a.md': text });
  return h.mount('notes/a.md');
}

function fakeClipboard(init: { items?: Array<Record<string, Blob>>; text?: string; readFails?: boolean; readTextFails?: boolean } = {}) {
  const written: string[] = [];
  const clip: ClipboardLike = {
    writeText: async (s: string) => void written.push(s),
    read: async () => {
      if (init.readFails || !init.items) throw new Error('denied');
      return init.items.map((m) => ({ types: Object.keys(m), getType: async (type: string) => m[type] }));
    },
    readText: async () => {
      if (init.readTextFails) throw new Error('denied');
      return init.text ?? '';
    },
  };
  return { clip, written };
}

/** jsdom 의 Blob 에는 text() 가 없을 수 있다: 같은 모양을 꾸민다. */
const textBlob = (s: string, type = 'text/plain') => Object.assign(new Blob([s], { type }), { text: async () => s });

describe('editor clipboard actions', () => {
  it('Copy writes the selection and leaves the note alone', async () => {
    const m = await open('abc def');
    act(() => m.view().dispatch({ selection: { anchor: 4, head: 7 } }));
    const { clip, written } = fakeClipboard();
    expect(await copySelection(m.view(), clip)).toBe(true);
    expect(written).toEqual(['def']);
    expect(m.view().state.doc.toString()).toBe('abc def');
  });

  it('Cut writes the selection, then deletes it in one undo step', async () => {
    const m = await open('abc def');
    act(() => m.view().dispatch({ selection: { anchor: 3, head: 7 } }));
    const { clip, written } = fakeClipboard();
    await act(() => cutSelection(m.view(), clip));
    expect(written).toEqual([' def']);
    expect(m.view().state.doc.toString()).toBe('abc');
    act(() => void undo(m.view()));
    expect(m.view().state.doc.toString()).toBe('abc def');
  });

  it('Cut and Copy do nothing without a selection', async () => {
    const m = await open('abc');
    const { clip, written } = fakeClipboard();
    expect(await copySelection(m.view(), clip)).toBe(false);
    expect(await cutSelection(m.view(), clip)).toBe(false);
    expect(written).toEqual([]);
  });

  it('Paste runs the editor paste path with the clipboard text', async () => {
    const m = await open('ab');
    act(() => m.view().dispatch({ selection: { anchor: 1 } }));
    const { clip } = fakeClipboard({ items: [{ 'text/plain': textBlob('XY') }] });
    await act(() => pasteClipboard(m.view(), clip, () => undefined));
    expect(m.view().state.doc.toString()).toBe('aXYb');
    expect(m.view().state.selection.main.head).toBe(3);
  });

  it('Paste falls back to readText when read() is refused', async () => {
    const m = await open('');
    const { clip } = fakeClipboard({ readFails: true, text: 'hello' });
    await act(() => pasteClipboard(m.view(), clip, () => undefined));
    expect(m.view().state.doc.toString()).toBe('hello');
  });

  it('Paste says so when the clipboard cannot be read', async () => {
    const m = await open('x');
    const notes: string[] = [];
    const { clip } = fakeClipboard({ readFails: true, readTextFails: true });
    expect(await pasteClipboard(m.view(), clip, (msg) => notes.push(msg))).toBe(false);
    expect(notes).toEqual([t('menu.pasteDenied')]);
    expect(m.view().state.doc.toString()).toBe('x');
  });

  it('Paste of an image hands a file to the paste event (the image pipeline takes it)', async () => {
    const m = await open('');
    const seen: Array<{ files: File[]; text: string }> = [];
    const listener = (e: Event) => {
      const dt = (e as ClipboardEvent).clipboardData!;
      seen.push({ files: Array.from(dt.files), text: dt.getData('text/plain') });
    };
    m.view().contentDOM.addEventListener('paste', listener, true);
    const png = new Blob([new Uint8Array([1, 2])], { type: 'image/png' });
    const { clip } = fakeClipboard({ items: [{ 'image/png': png }] });
    await act(() => pasteClipboard(m.view(), clip, () => undefined));
    expect(seen).toHaveLength(1);
    expect(seen[0].files.map((f) => f.type)).toEqual(['image/png']);
    expect(seen[0].text).toBe('');
  });

  it('Select all selects the whole note', async () => {
    const m = await open('one\ntwo');
    act(() => void selectAllIn(m.view()));
    expect(m.view().state.selection.main.from).toBe(0);
    expect(m.view().state.selection.main.to).toBe(7);
  });
});
