import { describe, expect, it } from 'vitest';
import { MENU_ITEMS, runMenuAction, type MenuDeps } from '../menuActions';

const deps = (quiet = false): MenuDeps & { calls: string[] } => {
  const calls: string[] = [];
  return {
    calls,
    quiet,
    hide: async () => void calls.push('hide'),
    setQuiet: async (q) => void calls.push(`quiet:${q}`),
    openMain: async () => void calls.push('open'),
  };
};

describe('the pet menu actions', () => {
  it('has exactly three entries, in this order, and no quit', () => {
    expect(MENU_ITEMS.map((i) => i.action)).toEqual(['hide', 'quiet', 'open']);
  });
  it('hide hides for now', async () => {
    const d = deps();
    await runMenuAction('hide', d);
    expect(d.calls).toEqual(['hide']);
  });
  it('quiet toggles from the current value', async () => {
    const off = deps(false);
    await runMenuAction('quiet', off);
    expect(off.calls).toEqual(['quiet:true']);
    const on = deps(true);
    await runMenuAction('quiet', on);
    expect(on.calls).toEqual(['quiet:false']);
  });
  it('open raises the main window, and only this action does', async () => {
    const d = deps();
    await runMenuAction('open', d);
    expect(d.calls).toEqual(['open']);
    for (const a of ['hide', 'quiet'] as const) {
      const e = deps();
      await runMenuAction(a, e);
      expect(e.calls).not.toContain('open');
    }
  });
  it('an unknown action does nothing', async () => {
    const d = deps();
    await runMenuAction('quit' as never, d);
    expect(d.calls).toEqual([]);
  });
});
