// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { waitFor } from '@testing-library/react';
import { runScopeHandlers, type EditorView } from '@codemirror/view';
import { completionStatus, currentCompletions, selectedCompletionIndex, startCompletion } from '@codemirror/autocomplete';
import { createFakeVault } from '../../../__tests__/fakeVault';
import { mountEditor } from '../../../labnote/__tests__/editorHarness';
import { setComposing } from '../../__tests__/composing';
import { linkIndex } from '../../../links/linkIndex';
import { activeCellView, focusCell } from '../cellEditor';

const DOC = '| a | b |\n|---|---|\n| x |  |\n\nend';
const PCR = '---\naliases: [중합]\n---\n';

beforeEach(() => {
  linkIndex.clear();
  linkIndex.setFiles(['n.md', 'notes/pcr.md']);
  linkIndex.setNote('notes/pcr.md', PCR);
  linkIndex.markReady();
});
afterEach(() => linkIndex.clear());

/** Opens `doc`, edits body cell (row 1, `col`), types `typed` at its end and waits until the list accepts keys. */
async function openCellList(doc: string, col: number, typed: string, tableFrom = 0) {
  const m = mountEditor(createFakeVault({ 'n.md': doc, 'notes/pcr.md': PCR }), 'n.md');
  await m.loaded();
  const outer = m.view();
  focusCell(outer, tableFrom, 1, col, 'end');
  const cell = activeCellView(outer)!;
  expect(cell).toBeTruthy();
  cell.dispatch({
    changes: { from: cell.state.doc.length, insert: typed },
    selection: { anchor: cell.state.doc.length + typed.length },
    userEvent: 'input.type',
  });
  startCompletion(cell);
  await waitFor(() => expect(completionStatus(cell.state)).toBe('active'));
  await new Promise((r) => setTimeout(r, 100)); // interactionDelay is 75 ms
  return { m, outer, cell };
}

const key = (v: EditorView, k: string, shift = false) =>
  runScopeHandlers(v, new KeyboardEvent('keydown', { key: k, shiftKey: shift }), 'editor');

describe('link completion in a table cell editor', () => {
  it('completion in a cell inserts an escaped alias and Enter accepts rather than leaving the cell', async () => {
    const { m, outer, cell } = await openCellList(DOC, 1, '[[중합');
    key(cell, 'Enter');
    expect(outer.state.doc.toString()).toBe('| a | b |\n|---|---|\n| x | [[pcr\\|중합]] |\n\nend');
    expect(activeCellView(outer)).toBe(cell); // still editing the same cell
    m.unmount();
  });

  it('Enter without an open completion still moves down', async () => {
    const m = mountEditor(createFakeVault({ 'n.md': DOC }), 'n.md');
    await m.loaded();
    const outer = m.view();
    focusCell(outer, 0, 1, 1, 'end');
    const cell = activeCellView(outer)!;
    expect(cell).toBeTruthy();
    key(cell, 'Enter');
    expect(activeCellView(outer)).not.toBe(cell);
    m.unmount();
  });

  it('Tab with an open list still moves to the next cell', async () => {
    const { m, outer, cell } = await openCellList(DOC, 0, '[[중');
    expect(key(cell, 'Tab')).toBe(true);
    const next = activeCellView(outer);
    expect(next).toBeTruthy();
    expect(next).not.toBe(cell);
    expect(outer.state.doc.toString()).toBe('| a | b |\n|---|---|\n| x[[중 |  |\n\nend');
    m.unmount();
  });

  it('Shift-Tab with an open list still moves to the previous cell', async () => {
    const { m, outer, cell } = await openCellList(DOC, 1, '[[중');
    expect(key(cell, 'Tab', true)).toBe(true);
    const prev = activeCellView(outer);
    expect(prev).toBeTruthy();
    expect(prev).not.toBe(cell);
    m.unmount();
  });

  it('Escape closes the list and keeps the cell', async () => {
    const { m, outer, cell } = await openCellList(DOC, 1, '[[중');
    expect(key(cell, 'Escape')).toBe(true);
    expect(completionStatus(cell.state)).toBe(null);
    expect(activeCellView(outer)).toBe(cell);
    m.unmount();
  });

  it('ArrowDown moves the list selection and keeps the cell', async () => {
    const { m, outer, cell } = await openCellList(DOC, 1, '[[');
    expect(currentCompletions(cell.state).length).toBeGreaterThan(1);
    expect(selectedCompletionIndex(cell.state)).toBe(0);
    expect(key(cell, 'ArrowDown')).toBe(true);
    expect(selectedCompletionIndex(cell.state)).toBe(1);
    expect(activeCellView(outer)).toBe(cell);
    expect(outer.state.doc.toString()).toBe('| a | b |\n|---|---|\n| x | [[ |\n\nend');
    m.unmount();
  });

  it.each(['Enter', 'Tab'])('%s while composing leaves the text and the cell alone', async (k) => {
    const { m, outer, cell } = await openCellList(DOC, 1, '[[중');
    setComposing(cell, true);
    const ev = new KeyboardEvent('keydown', { key: k, isComposing: true, keyCode: 229, bubbles: true, cancelable: true } as KeyboardEventInit);
    cell.contentDOM.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
    expect(cell.state.doc.toString()).toBe('[[중');
    expect(activeCellView(outer)).toBe(cell);
    expect(outer.state.doc.toString()).toBe('| a | b |\n|---|---|\n| x | [[중 |\n\nend');
    setComposing(cell, false);
    m.unmount();
  });

  it('[[# in a cell lists the note headings, not the cell text', async () => {
    const { m, cell } = await openCellList('# Top\n\n' + DOC, 1, '[[#', '# Top\n\n'.length);
    expect(currentCompletions(cell.state).map((c) => c.label)).toEqual(['Top']);
    m.unmount();
  });
});
