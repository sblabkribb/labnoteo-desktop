// @vitest-environment jsdom
/**
 * Task 29: 샘플 표시가 라이브 미리보기, 위키링크, 표, 모드 전환, 명령의 쓰기, README 의 sample_tracking, 한글 조합과
 * 함께 있을 때의 회귀 묶음. 모두 진짜 Editor(`createTestHost(SAMPLE_VAULT).mount`)로 연다.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, waitFor } from '@testing-library/react';
import type { EditorView } from '@codemirror/view';
import { setComposing } from '../../editor/__tests__/composing';
import { createTestHost, type TestHost } from '../../labnote/__tests__/testHost';
import { processNote } from '../../labnote/openNotes';
import { createSampleInteractive } from '../../labnote/port/sampleCreate';
import { createSampleEnv } from '../env';
import { samples } from '../sampleStore';
import { clearSampleSourceCaches, registerSampleSources } from '../sources';
import { LOCAL, NOTE, SAMPLE_VAULT } from './fixtures';

const README_PATH = 'labnote/061_PCR/README.labnote.md';
const marks = (v: EditorView) => [...v.contentDOM.querySelectorAll('.lno-sample-id')];
const missing = (v: EditorView) => [...v.contentDOM.querySelectorAll('.lno-sample-id-missing')];

let th: TestHost | undefined;
let errors: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  registerSampleSources();
  errors = vi.spyOn(console, 'error');
});
afterEach(() => {
  th?.cleanup();
  th = undefined;
  clearSampleSourceCaches();
  errors.mockRestore();
});

/** NOTE 를 `text` 로 바꾼 SAMPLE_VAULT 에서 진짜 편집기로 연다. 커서는 끝(마지막 빈 줄)에 둔다. */
async function open(text: string, settings: Parameters<typeof createTestHost>[1] = {}) {
  th = createTestHost({ ...SAMPLE_VAULT, [NOTE]: text }, settings);
  const m = await th.mount(NOTE);
  const v = m.view();
  act(() => v.dispatch({ selection: { anchor: v.state.doc.length } }));
  // 저장소가 등록부를 읽고 판을 올린 뒤의 표시를 본다
  await waitFor(() => expect(marks(m.view()).length).toBeGreaterThan(0));
  return m;
}

it('live preview chips, wikilink styling and sample marks share a line without nesting errors', async () => {
  const m = await open('[[Home]] DNA-1;pUC **bold** `DNA-2`\n\nend\n');
  const v = m.view();
  await waitFor(() => expect(missing(v).map((e) => e.textContent)).toEqual(['DNA-2']));
  expect(v.contentDOM.querySelectorAll('.lno-wikilink')).toHaveLength(1);
  expect(marks(v).map((e) => e.textContent)).toEqual(['DNA-1', 'DNA-2']);
  // DNA-2 in inline code is still marked (D1); DNA-1 is known
  expect(missing(v)[0].closest('.cm-line')).toBe(marks(v)[0].closest('.cm-line'));
  expect(errors).not.toHaveBeenCalled();
});

it('switching mode keeps sample marks and does not duplicate them', async () => {
  const m = await open('DNA-1 and Reagent-7 and DNA-2\n\nend\n');
  const before = marks(m.view()).length;
  expect(before).toBe(3);
  act(() => void m.toggleMode());
  expect(marks(m.view())).toHaveLength(before);
  act(() => void m.toggleMode());
  expect(marks(m.view())).toHaveLength(before);
});

it('a registry write from a command refreshes marks in the open editor without a keystroke', async () => {
  const m = await open('DNA-9 here\n\nend\n');
  await waitFor(() => expect(missing(m.view())).toHaveLength(1));
  const doc = m.view().state.doc.toString();
  th!.answer.prompt('DNA-9', 'pNew', 'fresh', 'Freezer A / C1');
  const created = await createSampleInteractive(createSampleEnv(th!.ctx), {
    type: 'DNA',
    folder: LOCAL,
    mode: 'manual',
    scope: 'local',
    initial: 'DNA-9',
  });
  expect(created).toBeTruthy();
  expect(JSON.parse(th!.vault.files()[`${LOCAL}/DNA.json`])['DNA-9']).toBeTruthy();
  await waitFor(() => expect(missing(m.view())).toHaveLength(0));
  expect(marks(m.view()).map((e) => e.textContent)).toEqual(['DNA-9']);
  expect(m.view().state.doc.toString()).toBe(doc); // no keystroke, no edit
});

it('README sample_tracking: no saved in the open README removes marks in another open experiment note', async () => {
  const m = await open('DNA-1 here\n\nend\n');
  const readme = await th!.mount(README_PATH);
  expect(readme.view().state.doc.toString()).toContain('sample_tracking: yes');
  expect(marks(m.view())).toHaveLength(1);
  await act(() => processNote(th!.host.fs, README_PATH, (t) => t.replace('sample_tracking: yes', 'sample_tracking: no')));
  expect(th!.vault.files()[README_PATH]).toContain('sample_tracking: no');
  // The app's vault watcher reports the README save (the Rust watcher does not filter the app's own writes).
  await act(async () => samples.vaultChanged([README_PATH]));
  await waitFor(() => expect(marks(m.view())).toHaveLength(0));
});

it('no element under the editor root has a style attribute set by sample code', async () => {
  const m = await open('DNA-1 DNA-9\n\n| ID |\n|---|\n| DNA-1 Reagent-7 DNA-9 |\n\nend\n');
  const v = m.view();
  await waitFor(() => expect(v.contentDOM.querySelectorAll('.lno-table-wrap .lno-sample-id')).toHaveLength(3));
  const all = [...marks(v), ...v.contentDOM.querySelectorAll('.lno-table-wrap .lno-sample-id')];
  expect(all.length).toBeGreaterThanOrEqual(5);
  for (const el of all) {
    expect(el.hasAttribute('style')).toBe(false);
    expect(el.querySelector('[style]')).toBeNull();
  }
});

it('typing a full Korean sentence with @배지;한글 commits every syllable', async () => {
  th = createTestHost({ ...SAMPLE_VAULT, [NOTE]: '\n' }, { customSampleTypes: ['배지'] });
  const m = await th.mount(NOTE);
  const v = m.view();
  act(() => v.dispatch({ selection: { anchor: 0 } }));
  const compose = async (syllable: string) => {
    await act(async () => {
      v.contentDOM.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      setComposing(v, true);
      const at = v.state.selection.main.head;
      v.dispatch({ changes: { from: at, insert: syllable }, selection: { anchor: at + syllable.length }, userEvent: 'input.type.compose' });
      setComposing(v, false);
      v.contentDOM.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 10));
    });
  };
  const type = async (text: string) => {
    await act(async () => {
      const at = v.state.selection.main.head;
      v.dispatch({ changes: { from: at, insert: text }, selection: { anchor: at + text.length }, userEvent: 'input.type' });
      await new Promise((r) => setTimeout(r, 10));
    });
  };
  await type('@');
  await compose('배');
  await compose('지');
  await type(';');
  await compose('한');
  await compose('글');
  await new Promise((r) => setTimeout(r, 100));
  expect(v.state.doc.toString()).toBe('@배지;한글\n');
  expect(v.state.doc.line(1).text.endsWith('@배지;한글')).toBe(true);
});
