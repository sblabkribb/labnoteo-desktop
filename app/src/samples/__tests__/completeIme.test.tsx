// @vitest-environment jsdom
/**
 * Task 13: `@` 샘플 완성을 실제 Editor 에서(조합 중 Enter, compositionend 뒤 다시 열기, `[[` 완성과 함께).
 */
import { afterEach, beforeEach, expect, it } from 'vitest';
import { waitFor } from '@testing-library/react';
import { completionStatus, currentCompletions, startCompletion } from '@codemirror/autocomplete';
import { mountEditor } from '../../labnote/__tests__/editorHarness';
import { setComposing } from '../../editor/__tests__/composing';
import { createTestHost, type TestHost } from '../../labnote/__tests__/testHost';
import { coreT } from '../../labnote/i18n';
import type { SampleEditorConfig } from '../editorConfig';
import { createSampleEnv } from '../env';
import { clearSampleSourceCaches, registerSampleSources } from '../sources';
import { sampleTypesFor } from '../types';
import { NOTE, SAMPLE_VAULT } from './fixtures';

let th: TestHost;
beforeEach(() => registerSampleSources());
afterEach(() => {
  th?.cleanup();
  clearSampleSourceCaches();
});

const cfg: SampleEditorConfig = {
  enabled: () => true,
  types: sampleTypesFor({ customSampleTypes: ['배지'] }),
  known: () => undefined,
  version: 0,
};

/** NOTE 를 `text` 로 연다(샘플 설정과 SampleEnv 를 준 실제 Editor). */
async function open(text: string) {
  th = createTestHost({ ...SAMPLE_VAULT, [NOTE]: text }, { customSampleTypes: ['배지'] });
  const env = createSampleEnv(th.ctx);
  const m = mountEditor(th.vault, NOTE, { samples: cfg, sampleEnv: () => env });
  await m.loaded();
  return { m, v: m.view() };
}

it('Enter while composing after @DNA; commits the syllable only', async () => {
  const { m, v } = await open('@DNA;');
  v.dispatch({ selection: { anchor: 5 } });
  startCompletion(v);
  await waitFor(() => expect(completionStatus(v.state)).toBe('active'));
  await new Promise((r) => setTimeout(r, 100)); // interactionDelay is 75 ms
  setComposing(v, true);
  v.dispatch({ changes: { from: 5, insert: '플' }, selection: { anchor: 6 }, userEvent: 'input.type.compose' });
  const ev = new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, keyCode: 229, bubbles: true, cancelable: true } as KeyboardEventInit);
  v.contentDOM.dispatchEvent(ev);
  expect(ev.defaultPrevented).toBe(false);
  expect(v.state.doc.toString()).toBe('@DNA;플'); // no option applied, no newline
  await waitFor(() => expect(completionStatus(v.state)).toBe('active'));
  setComposing(v, false);
  m.unmount();
});

it('list reopens after compositionend in @배지;', async () => {
  const { m, v } = await open('');
  v.contentDOM.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
  setComposing(v, true);
  v.dispatch({ changes: { from: 0, insert: '@배지;' }, selection: { anchor: 4 } }); // not an input.type transaction
  setComposing(v, false);
  expect(completionStatus(v.state)).toBeNull();
  v.contentDOM.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 5));
  await waitFor(() => expect(completionStatus(v.state)).toBe('active'));
  expect(currentCompletions(v.state).map((c) => c.label)).toContain(coreT('Generate new {0} ID', '배지'));
  m.unmount();
});

it('compositionend outside a trigger opens nothing', async () => {
  const { m, v } = await open('');
  v.contentDOM.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
  v.dispatch({ changes: { from: 0, insert: '배지' }, selection: { anchor: 2 } });
  v.contentDOM.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 100));
  expect(completionStatus(v.state)).toBeNull();
  m.unmount();
});

it('wiki and sample completion coexist', async () => {
  const { m, v } = await open('[[Ho\n@DNA;');
  v.dispatch({ selection: { anchor: 4 } });
  startCompletion(v);
  await waitFor(() => expect(currentCompletions(v.state).map((c) => c.label)).toContain('Home'));
  v.dispatch({ selection: { anchor: v.state.doc.length } });
  startCompletion(v);
  await waitFor(() => expect(currentCompletions(v.state).map((c) => c.label)).toContain('DNA-1 (pUC) - miniprep'));
  expect(currentCompletions(v.state).map((c) => c.label)).not.toContain('Home');
  // the editor's optionClass puts the sample class on the rendered option
  await waitFor(() => expect(v.dom.querySelectorAll('.cm-tooltip-autocomplete li.lno-sample-option').length).toBeGreaterThan(0));
  m.unmount();
});
