// @vitest-environment jsdom
/**
 * Task 10: 그려진(편집 중이 아닌) 표 셀의 샘플 표시. renderInline 의 클래스뿐인 꾸밈과 sampleCellDecorator.
 */
import { describe, expect, it } from 'vitest';
import { act, waitFor } from '@testing-library/react';
import { EditorState } from '@codemirror/state';
import { createFakeVault } from '../../__tests__/fakeVault';
import { mountEditor } from '../../labnote/__tests__/editorHarness';
import { renderInline } from '../../editor/table/renderInline';
import { activeCellView, focusCell } from '../../editor/table/cellEditor';
import type { KnownSampleIds } from '../../labnote/port/sampleIdIndex';
import { sampleCellDecorator } from '../cellMarks';
import { sampleEditorConfig, sampleNotePath, type SampleEditorConfig } from '../editorConfig';
import { sampleTypesFor } from '../types';
import { KNOWN, KNOWN_WITH_DNA9, NOTE } from './fixtures';

const cfg = (known?: KnownSampleIds, enabled = true): SampleEditorConfig => ({
  enabled: () => enabled,
  types: sampleTypesFor({ customSampleTypes: [] }),
  known: () => known,
  version: known?.version ?? 0,
});
const lastCell = (root: HTMLElement) => [...root.querySelectorAll('.lno-table-wrap td')].at(-1)!;

describe('sample marks in rendered table cells', () => {
  it('rendered table cells show sample marks with classes only', async () => {
    const m = mountEditor(createFakeVault({ [NOTE]: '| ID |\n|---|\n| DNA-1 DNA-9 |\n' }), NOTE, { samples: cfg(KNOWN) });
    await m.loaded();
    const cell = lastCell(m.view().contentDOM);
    expect([...cell.querySelectorAll('.lno-sample-id')].map((e) => e.className)).toEqual([
      'lno-sample-id lno-sample-t-dna',
      'lno-sample-id lno-sample-t-dna lno-sample-id-missing',
    ]);
    expect(cell.querySelector('.lno-sample-id-missing')!.getAttribute('title')).toBeTruthy();
    expect(cell.querySelector('[style]')).toBeNull();
    m.setSamples(cfg(KNOWN_WITH_DNA9));
    await waitFor(() => expect(m.view().contentDOM.querySelectorAll('.lno-table-wrap .lno-sample-id-missing')).toHaveLength(0));
    expect(m.view().contentDOM.querySelectorAll('.lno-table-wrap .lno-sample-id')).toHaveLength(2);
    m.unmount();
  });

  it('a definition added outside the table clears the missing mark in the rendered cell', async () => {
    const m = mountEditor(createFakeVault({ [NOTE]: '| ID |\n|---|\n| DNA-9 |\n' }), NOTE, { samples: cfg(KNOWN) });
    await m.loaded();
    expect(m.view().contentDOM.querySelectorAll('.lno-table-wrap .lno-sample-id-missing')).toHaveLength(1);
    await m.type('\n@dna;DNA-9;x\n');
    await waitFor(() => expect(m.view().contentDOM.querySelectorAll('.lno-table-wrap .lno-sample-id-missing')).toHaveLength(0));
    m.unmount();
  });

  it('a cell repainted after its cell editor closes keeps the sample marks', async () => {
    const m = mountEditor(createFakeVault({ [NOTE]: '| ID |\n|---|\n| DNA-9 |\n' }), NOTE, { samples: cfg(KNOWN) });
    await m.loaded();
    const outer = m.view();
    act(() => void focusCell(outer, 0, 1, 0, 'end'));
    const nested = activeCellView(outer)!;
    expect(nested).toBeTruthy();
    act(() => void nested.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    expect(activeCellView(outer)).toBeNull();
    const cell = lastCell(outer.contentDOM);
    expect(cell.querySelectorAll('.lno-sample-id.lno-sample-id-missing')).toHaveLength(1);
    expect(cell.textContent).toBe('DNA-9');
    m.unmount();
  });

  it('without a config or with tracking off the cells are plain', async () => {
    for (const samples of [null, cfg(KNOWN, false)]) {
      const m = mountEditor(createFakeVault({ [NOTE]: '| ID |\n|---|\n| DNA-1 |\n' }), NOTE, { samples });
      await m.loaded();
      expect(lastCell(m.view().contentDOM).querySelectorAll('.lno-sample-id')).toHaveLength(0);
      expect(lastCell(m.view().contentDOM).textContent).toBe('DNA-1');
      m.unmount();
    }
  });

  it('sampleCellDecorator is undefined without a config or when the note is not enabled', () => {
    const st = (c: SampleEditorConfig | null) => EditorState.create({ extensions: [sampleEditorConfig.of(c), sampleNotePath.of(NOTE)] });
    expect(sampleCellDecorator(st(null))).toBeUndefined();
    expect(sampleCellDecorator(st(cfg(KNOWN, false)))).toBeUndefined();
    expect(sampleCellDecorator(st(cfg(KNOWN)))!('x DNA-1').map((r) => [r.from, r.to])).toEqual([[2, 7]]);
  });
});

describe('renderInline decorator', () => {
  it('renderInline without a decorator is unchanged; decorated spans keep the inline markup around them', () => {
    const plain = document.createElement('div');
    renderInline('**b** DNA-1', plain);
    expect(plain.innerHTML).toBe('<strong>b</strong> DNA-1');
    const el = document.createElement('div');
    renderInline('**b** DNA-1', el, () => [{ from: 6, to: 11, cls: 'x' }]);
    expect(el.innerHTML).toBe('<strong>b</strong> <span class="x">DNA-1</span>');
  });

  it('marks inside bold and code keep their place; a range crossing a token boundary is dropped', () => {
    const el = document.createElement('div');
    renderInline('**DNA-1** `DNA-2`', el, () => [
      { from: 2, to: 7, cls: 'a', title: 't' },
      { from: 11, to: 16, cls: 'b' },
    ]);
    expect(el.innerHTML).toBe('<strong><span class="a" title="t">DNA-1</span></strong> <code><span class="b">DNA-2</span></code>');
    const cross = document.createElement('div');
    renderInline('**b** x', cross, () => [{ from: 3, to: 7, cls: 'x' }]);
    expect(cross.innerHTML).toBe('<strong>b</strong> x');
  });
});
