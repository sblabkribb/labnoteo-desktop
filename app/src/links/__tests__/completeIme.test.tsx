// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';
import { runScopeHandlers } from '@codemirror/view';
import { completionStatus, currentCompletions, startCompletion } from '@codemirror/autocomplete';
import { createFakeVault } from '../../__tests__/fakeVault';
import { mountEditor } from '../../labnote/__tests__/editorHarness';
import { setComposing } from '../../editor/__tests__/composing';
import { linkIndex } from '../linkIndex';

beforeEach(() => {
  linkIndex.clear();
  linkIndex.setFiles(['n.md', 'Home.md', 'notes/pcr.md']);
  linkIndex.setNote('notes/pcr.md', '---\naliases: [중합]\n---\n');
  linkIndex.markReady();
});
afterEach(() => {
  vi.useRealTimers();
  linkIndex.clear();
});

/** Opens `n.md`, puts the cursor at `at` and waits until the list is open and accepts keys. */
async function openList(text: string, at: number) {
  const m = mountEditor(createFakeVault({ 'n.md': text, 'Home.md': '', 'notes/pcr.md': '---\naliases: [중합]\n---\n' }), 'n.md');
  await m.loaded();
  const v = m.view();
  v.dispatch({ selection: { anchor: at } });
  startCompletion(v);
  await waitFor(() => expect(completionStatus(v.state)).toBe('active'));
  await new Promise((r) => setTimeout(r, 100)); // interactionDelay is 75 ms
  return { m, v };
}

describe('wikilink completion in the editor', () => {
  it('Enter accepts an open completion before the list keys continue the item', async () => {
    const { m, v } = await openList('- [[hom', 7);
    runScopeHandlers(v, new KeyboardEvent('keydown', { key: 'Enter' }), 'editor');
    expect(v.state.doc.toString()).toBe('- [[Home]]');
    m.unmount();
  });

  it('Enter while composing does not accept', async () => {
    const { m, v } = await openList('[[중', 3);
    setComposing(v, true);
    const ev = new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, keyCode: 229, bubbles: true, cancelable: true } as KeyboardEventInit);
    v.contentDOM.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false); // the IME still gets its commit key
    expect(v.state.doc.toString()).toBe('[[중'); // no newline, no accept
    expect(completionStatus(v.state)).toBe('active');
    setComposing(v, false);
    m.unmount();
  });

  it('Tab while composing does not accept', async () => {
    const { m, v } = await openList('[[중', 3);
    setComposing(v, true);
    const ev = new KeyboardEvent('keydown', { key: 'Tab', isComposing: true, keyCode: 229, bubbles: true, cancelable: true } as KeyboardEventInit);
    v.contentDOM.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
    expect(v.state.doc.toString()).toBe('[[중');
    expect(completionStatus(v.state)).toBe('active');
    setComposing(v, false);
    m.unmount();
  });

  // CodeMirror drops key events itself once it has seen compositionstart; the first keydown of a syllable
  // (keyCode 229, isComposing) can come before it, and only the guard keeps that Enter from accepting.
  it('Enter with keyCode 229 before compositionstart does not accept', async () => {
    const { m, v } = await openList('[[중', 3);
    const ev = new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, keyCode: 229, bubbles: true, cancelable: true } as KeyboardEventInit);
    v.contentDOM.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
    expect(v.state.doc.toString()).toBe('[[중');
    expect(completionStatus(v.state)).toBe('active');
    m.unmount();
  });

  it('compositionend opens the list even when the composed text did not', async () => {
    const m = mountEditor(createFakeVault({ 'n.md': '[[', 'notes/pcr.md': '---\naliases: [중합]\n---\n' }), 'n.md');
    await m.loaded();
    const v = m.view();
    v.dispatch({ selection: { anchor: 2 } });
    v.contentDOM.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    v.dispatch({ changes: { from: 2, insert: '중합' }, selection: { anchor: 4 } }); // not an input.type transaction
    expect(completionStatus(v.state)).toBeNull();
    v.contentDOM.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    await waitFor(() => expect(completionStatus(v.state)).toBe('active'));
    expect(currentCompletions(v.state).map((c) => c.label)).toContain('중합');
    m.unmount();
  });

  it('compositionend outside a wikilink opens nothing', async () => {
    const m = mountEditor(createFakeVault({ 'n.md': 'x ' }), 'n.md');
    await m.loaded();
    const v = m.view();
    v.dispatch({ selection: { anchor: 2 } });
    v.contentDOM.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    v.dispatch({ changes: { from: 2, insert: '중합' }, selection: { anchor: 4 } });
    v.contentDOM.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 100));
    expect(completionStatus(v.state)).toBeNull();
    m.unmount();
  });

  it('compositionend reopens the list so the follow-up Enter accepts', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const m = mountEditor(createFakeVault({ 'n.md': '[[', 'notes/pcr.md': '---\naliases: [중합]\n---\n' }), 'n.md');
    await m.loaded();
    const v = m.view();
    v.dispatch({ selection: { anchor: 2 } });
    v.contentDOM.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    setComposing(v, true);
    v.dispatch({ changes: { from: 2, insert: '중합' }, selection: { anchor: 4 }, userEvent: 'input.type.compose' });
    setComposing(v, false);
    v.contentDOM.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    vi.advanceTimersByTime(1);
    await waitFor(() => expect(completionStatus(v.state)).toBe('active'));
    expect(currentCompletions(v.state).map((c) => c.label)).toContain('중합');
    vi.useRealTimers();
    m.unmount();
  });
});
