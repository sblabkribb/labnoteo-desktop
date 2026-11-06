// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, waitFor } from '@testing-library/react';
import { createFakeVault } from '../../__tests__/fakeVault';
import { mountEditor } from '../../labnote/__tests__/editorHarness';
import { linkIndex } from '../../links/linkIndex';
import { LINKS_MS } from '../Editor';
import { linkResolution } from '../live/linkResolution';
import { setComposing } from './composing';

afterEach(() => {
  vi.useRealTimers();
  linkIndex.clear();
});

const flush = () => act(async () => void (await Promise.resolve()));

describe('editor link resolution', () => {
  it('typing does not reconfigure resolution', async () => {
    linkIndex.clear();
    linkIndex.setFiles(['n.md', 'Home.md']);
    linkIndex.markReady();
    const m = mountEditor(createFakeVault({ 'n.md': '[[Home]]', 'Home.md': '' }), 'n.md');
    await m.loaded();
    vi.useFakeTimers();
    const v = m.view();
    const before = v.state.facet(linkResolution);
    expect(before).not.toBeNull();
    act(() => v.dispatch({ changes: { from: 8, insert: ' [[Nope]]' } }));
    act(() => void vi.advanceTimersByTime(LINKS_MS));
    await flush();
    expect(v.state.facet(linkResolution)).toBe(before);
    expect(v.contentDOM.querySelector('.lno-unresolved')).not.toBeNull();
    linkIndex.addFiles(['Nope.md']);
    await flush();
    expect(v.state.facet(linkResolution)).not.toBe(before);
    expect(v.contentDOM.querySelector('.lno-unresolved')).toBeNull();
    m.unmount();
  });

  it('is null until the index is ready, then resolves', async () => {
    linkIndex.clear();
    linkIndex.setFiles(['n.md']);
    const m = mountEditor(createFakeVault({ 'n.md': '[[Nope]]\nx' }), 'n.md');
    await m.loaded();
    expect(m.view().state.facet(linkResolution)).toBeNull();
    expect(m.view().contentDOM.querySelector('.lno-unresolved')).toBeNull();
    linkIndex.markReady();
    await flush();
    expect(m.view().state.facet(linkResolution)).not.toBeNull();
    expect(m.view().contentDOM.querySelector('.lno-unresolved')).not.toBeNull();
    m.unmount();
  });

  it('an index change while composing waits for the composition to end', async () => {
    linkIndex.clear();
    linkIndex.setFiles(['n.md']);
    linkIndex.markReady();
    const m = mountEditor(createFakeVault({ 'n.md': '[[Home]]\nx' }), 'n.md');
    await m.loaded();
    const v = m.view();
    const before = v.state.facet(linkResolution);
    setComposing(v, true);
    linkIndex.addFiles(['Home.md']);
    await flush();
    expect(v.state.facet(linkResolution)).toBe(before);
    setComposing(v, false);
    act(() => v.dispatch({}));
    expect(v.state.facet(linkResolution)).not.toBe(before);
    expect(v.contentDOM.querySelector('.lno-unresolved')).toBeNull();
    m.unmount();
  });

  it('a reload keeps the unresolved style', async () => {
    linkIndex.clear();
    linkIndex.setFiles(['n.md']);
    linkIndex.markReady();
    const vault = createFakeVault({ 'n.md': '[[Nope]]\nx' });
    const m = mountEditor(vault, 'n.md');
    await m.loaded();
    expect(m.view().contentDOM.querySelector('.lno-unresolved')).not.toBeNull();
    await act(async () => {
      await vault.mem.write('n.md', '[[Nope]]\ny');
      await vault.emitChange('n.md', 'modified'); // external change: the editor adopts a new state
    });
    await waitFor(() => expect(m.view().state.doc.toString()).toBe('[[Nope]]\ny'));
    expect(m.view().contentDOM.querySelector('.lno-unresolved')).not.toBeNull();
    m.unmount();
  });
});
