// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from '@testing-library/react';
import { createFakeVault } from '../../__tests__/fakeVault';
import { mountEditor } from '../../labnote/__tests__/editorHarness';
import { linkIndex } from '../../links/linkIndex';
import { LINKS_MS } from '../Editor';
import { setComposing } from './composing';

beforeEach(() => {
  linkIndex.clear();
  linkIndex.setFiles(['n.md', 'Home.md']);
});
afterEach(() => {
  vi.useRealTimers();
  linkIndex.clear();
});

/** Opens `n.md` and waits for the load with real timers (waitFor stalls under fake ones), then fakes the clock. */
async function open(text: string) {
  const vault = createFakeVault({ 'n.md': text, 'Home.md': '' });
  const m = mountEditor(vault, 'n.md');
  await m.loaded();
  vi.useFakeTimers();
  return m;
}
const sources = () => linkIndex.backlinks('Home.md').map((b) => b.source);
const advance = (ms: number) => act(() => void vi.advanceTimersByTime(ms));

describe('editor buffer overlay', () => {
  it('LINKS_MS is 300', () => expect(LINKS_MS).toBe(300));

  it('publishes the buffer as an overlay, debounced, and clears it on unmount', async () => {
    const m = await open('x');
    const v = m.view();
    act(() => v.dispatch({ changes: { from: 1, insert: ' [[Home]]' } }));
    expect(linkIndex.backlinks('Home.md')).toEqual([]);
    advance(299);
    expect(linkIndex.backlinks('Home.md')).toEqual([]);
    advance(1);
    expect(sources()).toEqual(['n.md']);
    m.unmount();
    expect(linkIndex.backlinks('Home.md')).toEqual([]);
  });

  it('publishes the loaded text at once after adopt', async () => {
    const m = await open('see [[Home]]');
    expect(sources()).toEqual(['n.md']);
    m.unmount();
  });

  it('waits for composition to end', async () => {
    const m = await open('x');
    const v = m.view();
    setComposing(v, true);
    act(() => v.dispatch({ changes: { from: 1, insert: '[[Home]]' }, userEvent: 'input.type.compose' }));
    advance(300);
    expect(linkIndex.backlinks('Home.md')).toEqual([]);
    m.ref.current!.publishLinks(); // a no-op while composing
    expect(linkIndex.backlinks('Home.md')).toEqual([]);
    setComposing(v, false);
    act(() => v.dispatch({}));
    advance(300);
    expect(sources()).toEqual(['n.md']);
    m.unmount();
  });

  it('publishLinks publishes at once', async () => {
    const m = await open('x');
    act(() => m.view().dispatch({ changes: { from: 1, insert: '[[Home]]' } }));
    m.ref.current!.publishLinks();
    expect(sources()).toEqual(['n.md']);
    m.unmount();
  });
});
