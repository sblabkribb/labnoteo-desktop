// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { waitFor } from '@testing-library/react';
import { runScopeHandlers } from '@codemirror/view';
import { completionStatus, startCompletion } from '@codemirror/autocomplete';
import { createFakeVault } from '../../../__tests__/fakeVault';
import { mountEditor } from '../../../labnote/__tests__/editorHarness';
import { linkIndex } from '../../../links/linkIndex';
import { activeCellView, focusCell } from '../cellEditor';

const DOC = '| a | b |\n|---|---|\n| x |  |\n\nend';

beforeEach(() => {
  linkIndex.clear();
  linkIndex.setFiles(['n.md', 'notes/pcr.md']);
  linkIndex.setNote('notes/pcr.md', '---\naliases: [중합]\n---\n');
  linkIndex.markReady();
});
afterEach(() => linkIndex.clear());

describe('link completion in a table cell editor', () => {
  it('completion in a cell inserts an escaped alias and Enter accepts rather than leaving the cell', async () => {
    const m = mountEditor(createFakeVault({ 'n.md': DOC, 'notes/pcr.md': '---\naliases: [중합]\n---\n' }), 'n.md');
    await m.loaded();
    const outer = m.view();
    focusCell(outer, 0, 1, 1, 'end'); // first body row, second column
    const cell = activeCellView(outer)!;
    expect(cell).toBeTruthy();
    cell.dispatch({
      changes: { from: cell.state.doc.length, insert: '[[중합' },
      selection: { anchor: cell.state.doc.length + 4 },
      userEvent: 'input.type',
    });
    startCompletion(cell);
    await waitFor(() => expect(completionStatus(cell.state)).toBe('active'));
    await new Promise((r) => setTimeout(r, 100)); // interactionDelay is 75 ms
    runScopeHandlers(cell, new KeyboardEvent('keydown', { key: 'Enter' }), 'editor');
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
    runScopeHandlers(cell, new KeyboardEvent('keydown', { key: 'Enter' }), 'editor');
    expect(activeCellView(outer)).not.toBe(cell);
    m.unmount();
  });
});
