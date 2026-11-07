import { NAV_MAX, NavHistory } from '../navHistory';

describe('NavHistory', () => {
  it('walks back and forward', () => {
    const n = new NavHistory();
    n.push({ path: 'a.md', line: 3 });
    n.push({ path: 'b.md', line: 0 });
    expect(n.back({ path: 'c.md', line: 1 })).toEqual({ path: 'b.md', line: 0 });
    expect(n.back({ path: 'b.md', line: 0 })).toEqual({ path: 'a.md', line: 3 });
    expect(n.forward({ path: 'a.md', line: 3 })).toEqual({ path: 'b.md', line: 0 });
    n.push({ path: 'b.md', line: 2 });
    expect(n.canForward()).toBe(false);
  });

  it('drops deleted notes and follows renames', () => {
    const n = new NavHistory();
    n.push({ path: 'notes/a.md', line: 1 });
    n.push({ path: 'x.md', line: 0 });
    n.drop('x.md');
    n.rename([{ from: 'notes/a.md', to: 'docs/a.md' }]);
    expect(n.back({ path: 'y.md', line: 0 })).toEqual({ path: 'docs/a.md', line: 1 });
    expect(n.canBack()).toBe(false);
  });

  it('drops a deleted folder, entries on the forward stack too, and nothing outside it', () => {
    const n = new NavHistory();
    n.push({ path: 'dir/a.md', line: 0 });
    n.push({ path: 'dir2.md', line: 0 });
    n.push({ path: 'dir/sub/b.md', line: 0 });
    expect(n.back({ path: 'c.md', line: 0 })).toEqual({ path: 'dir/sub/b.md', line: 0 });
    n.drop('dir');
    expect(n.canForward()).toBe(true); // c.md stays
    expect(n.back({ path: 'dir/sub/b.md', line: 0 })).toEqual({ path: 'dir2.md', line: 0 });
    expect(n.canBack()).toBe(false);
  });

  it('a case-only rename maps the entry instead of losing it', () => {
    const n = new NavHistory();
    n.push({ path: 'a.md', line: 2 });
    n.rename([{ from: 'a.md', to: 'A.md' }]);
    expect(n.back({ path: 'z.md', line: 0 })).toEqual({ path: 'A.md', line: 2 });
  });

  it('back and forward with nothing there return undefined and change nothing', () => {
    const n = new NavHistory();
    expect(n.back({ path: 'a.md', line: 0 })).toBeUndefined();
    expect(n.forward({ path: 'a.md', line: 0 })).toBeUndefined();
    expect(n.canBack()).toBe(false);
    expect(n.canForward()).toBe(false);
  });

  it('caps the stack', () => {
    const n = new NavHistory();
    for (let i = 0; i < NAV_MAX + 5; i++) n.push({ path: `${i}.md`, line: 0 });
    let k = 0;
    while (n.back({ path: 'z.md', line: 0 })) k++;
    expect(k).toBe(NAV_MAX);
  });
});
