// @vitest-environment jsdom
/**
 * Task 9: 샘플 ID 강조 ViewPlugin(소스·라이브 모드, 표 셀 편집기), 조합 중 미룸, 설정 칸 갈아 끼우기.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { act } from '@testing-library/react';
import { EditorView } from '@codemirror/view';
import { createFakeVault } from '../../__tests__/fakeVault';
import { mountEditor } from '../../labnote/__tests__/editorHarness';
import { setComposing } from '../../editor/__tests__/composing';
import { coreT } from '../../labnote/i18n';
import { activeCellView, focusCell } from '../../editor/table/cellEditor';
import { getMode, setMode } from '../../editor/live/mode';
import type { KnownSampleIds } from '../../labnote/port/sampleIdIndex';
import type { SampleEditorConfig } from '../editorConfig';
import { sampleTypesFor } from '../types';
import { KNOWN, KNOWN_WITH_DNA9, NOTE } from './fixtures';

const startMode = getMode();
afterEach(() => setMode(startMode));

const cfg = (known?: KnownSampleIds, enabled = true): SampleEditorConfig => ({
  enabled: () => enabled,
  types: sampleTypesFor({ customSampleTypes: [] }),
  known: () => known,
  version: known?.version ?? 0,
});
const marks = (v: EditorView) => [...v.contentDOM.querySelectorAll('.lno-sample-id')];
const microtask = () => act(() => new Promise<void>((r) => queueMicrotask(r)));

describe('sample highlight in the editor', () => {
  it('marks IDs in source and live mode, with title and no style attribute', async () => {
    const m = mountEditor(createFakeVault({ [NOTE]: 'x DNA-1 DNA-9\n' }), NOTE, { samples: cfg(KNOWN) });
    await m.loaded();
    expect(marks(m.view()).map((e) => e.textContent)).toEqual(['DNA-1', 'DNA-9']);
    expect(marks(m.view())[1].getAttribute('title')).toBe(coreT('Not in the sample registry'));
    expect(marks(m.view()).every((e) => !e.hasAttribute('style'))).toBe(true);
    act(() => m.toggleMode());
    expect(getMode()).not.toBe(startMode);
    expect(marks(m.view())).toHaveLength(2);
    m.unmount();
  });

  it('live mode shows a definition without its ; separators until the caret is on the line', async () => {
    setMode('live');
    const m = mountEditor(createFakeVault({ [NOTE]: 'top\n@dna;DNA-5;GFP;PCR product\n' }), NOTE, { samples: cfg(KNOWN) });
    await m.loaded();
    m.view().dispatch({ selection: { anchor: 0 } });
    const line = () => m.view().contentDOM.querySelectorAll('.cm-line')[1];
    expect(line().textContent).toBe('@dnaDNA-5·GFP·PCR product');
    expect(line().querySelectorAll('.lno-sample-sep')).toHaveLength(2);
    m.view().dispatch({ selection: { anchor: m.view().state.doc.line(2).from + 2 } });
    expect(line().textContent).toBe('@dna;DNA-5;GFP;PCR product');
    act(() => setMode('source'));
    await microtask();
    m.view().dispatch({ selection: { anchor: 0 } });
    expect(line().textContent).toBe('@dna;DNA-5;GFP;PCR product');
    m.unmount();
  });

  it('no rebuild while composing; rebuilds after compositionend', async () => {
    const m = mountEditor(createFakeVault({ [NOTE]: 'x\n' }), NOTE, { samples: cfg(KNOWN) });
    await m.loaded();
    setComposing(m.view(), true);
    await m.type(' DNA-1');
    expect(marks(m.view())).toHaveLength(0);
    setComposing(m.view(), false);
    m.view().dispatch({});
    expect(marks(m.view())).toHaveLength(1);
    m.unmount();
  });

  it('config reconfigure waits for composition', async () => {
    const m = mountEditor(createFakeVault({ [NOTE]: 'DNA-9\n' }), NOTE, { samples: cfg(KNOWN) });
    await m.loaded();
    setComposing(m.view(), true);
    m.setSamples(cfg(KNOWN_WITH_DNA9));
    expect(m.view().contentDOM.querySelectorAll('.lno-sample-id-missing')).toHaveLength(1);
    setComposing(m.view(), false);
    m.view().dispatch({});
    expect(m.view().contentDOM.querySelectorAll('.lno-sample-id-missing')).toHaveLength(0);
    m.unmount();
  });

  it('a definition scrolled out of view still counts as known', async () => {
    const doc = '@dna;DNA-5;x\n' + '\n'.repeat(400) + 'DNA-5\n';
    const m = mountEditor(createFakeVault({ [NOTE]: doc }), NOTE, { samples: cfg(KNOWN) });
    await m.loaded();
    m.view().dispatch({ effects: EditorView.scrollIntoView(doc.length - 2) });
    expect(marks(m.view()).length).toBeGreaterThan(0);
    expect(m.view().contentDOM.querySelectorAll('.lno-sample-id-missing')).toHaveLength(0);
    m.unmount();
  });

  it('disabled path draws nothing', async () => {
    const m = mountEditor(createFakeVault({ [NOTE]: 'DNA-1\n' }), NOTE, { samples: cfg(KNOWN, false) });
    await m.loaded();
    expect(marks(m.view())).toHaveLength(0);
    m.unmount();
  });

  it('no config draws nothing', async () => {
    const m = mountEditor(createFakeVault({ [NOTE]: 'DNA-1\n' }), NOTE, { samples: null });
    await m.loaded();
    expect(marks(m.view())).toHaveLength(0);
    m.unmount();
  });

  it('the active table cell editor draws sample marks on open, without a keystroke', async () => {
    setMode('live');
    const m = mountEditor(createFakeVault({ [NOTE]: '| a |\n|---|\n| DNA-1 |\n' }), NOTE, { samples: cfg(KNOWN) });
    await m.loaded();
    const outer = m.view();
    act(() => void focusCell(outer, 0, 1, 0, 'end'));
    const cell = activeCellView(outer)!;
    expect(cell).toBeTruthy();
    await microtask();
    expect(marks(cell).map((e) => e.textContent)).toEqual(['DNA-1']);
    m.unmount();
  });

  it('the cell editor follows a store version bump', async () => {
    setMode('live');
    const m = mountEditor(createFakeVault({ [NOTE]: '| a |\n|---|\n| DNA-9 |\n' }), NOTE, { samples: cfg(KNOWN) });
    await m.loaded();
    const outer = m.view();
    act(() => void focusCell(outer, 0, 1, 0, 'end'));
    const cell = activeCellView(outer)!;
    await microtask();
    expect(cell.contentDOM.querySelectorAll('.lno-sample-id-missing')).toHaveLength(1);
    m.setSamples(cfg(KNOWN_WITH_DNA9));
    await microtask();
    expect(activeCellView(outer)).toBe(cell);
    expect(marks(cell)).toHaveLength(1);
    expect(cell.contentDOM.querySelectorAll('.lno-sample-id-missing')).toHaveLength(0);
    m.unmount();
  });
});
