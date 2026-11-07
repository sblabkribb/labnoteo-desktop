// @vitest-environment jsdom
/**
 * End-to-end resolution freshness (plan SP4 Task 26): the real Editor over fakeVault, the singleton `linkIndex`
 * and a `LinkSync` over the fake vault, fed the watcher events the app would get after its own writes.
 */
import { waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createFromLink } from '../../links/createFromLink';
import { linkIndex } from '../../links/linkIndex';
import { createLinkSync, tauriLinkSource } from '../../links/loadLinks';
import type { TreeEntry } from '../../tree/useTree';
import { renameEntry } from '../commands/fileOps';
import { createTestHost, type TestHost } from './testHost';

const entries = (h: TestHost): TreeEntry[] =>
  Object.keys(h.vault.files()).map((p) => ({ path: p, name: p.split('/').pop()!, isDir: false, depth: p.split('/').length - 1 }));

const hosts: TestHost[] = [];
const host = (...a: Parameters<typeof createTestHost>): TestHost => {
  const h = createTestHost(...a);
  hosts.push(h);
  return h;
};
afterEach(() => {
  for (const h of hosts.splice(0)) h.cleanup();
});

describe('links flow: resolution stays fresh in the open editor', () => {
  it('creating the target of an unresolved link clears its faded style', async () => {
    const h = host({ 'n.md': '[[New]]\nx' });
    const m = await h.mount('n.md');
    expect(m.view().contentDOM.querySelector('.lno-unresolved')).not.toBeNull();
    expect(await createFromLink(h.ctx, 'New', 'n.md')).toBe('New.md');
    const sync = createLinkSync(linkIndex, tauriLinkSource(h.vault.invoke));
    await sync.apply([{ path: 'New.md', kind: 'created' }]); // what the watcher event does in the app
    await waitFor(() => expect(m.view().contentDOM.querySelector('.lno-unresolved')).toBeNull());
  });

  it('renaming the target keeps the open referrer resolved', async () => {
    const h = host({ 'Home.md': '', 'n.md': '[[Home]]\nx' });
    const m = await h.mount('n.md');
    h.answer.prompt('Start'); h.answer.pick('update');
    await renameEntry(h.ctx, 'Home.md', false, entries(h));
    const sync = createLinkSync(linkIndex, tauriLinkSource(h.vault.invoke));
    await sync.apply([{ path: 'Home.md', kind: 'removed' }, { path: 'Start.md', kind: 'created' }, { path: 'n.md', kind: 'modified' }]);
    await waitFor(() => expect(m.view().state.doc.toString()).toBe('[[Start]]\nx'));
    expect(m.view().contentDOM.querySelector('.lno-unresolved')).toBeNull();
    expect(m.ref.current!.busy()).toBe(false);
    expect(h.asked.confirm).toEqual([]);
  });
});
