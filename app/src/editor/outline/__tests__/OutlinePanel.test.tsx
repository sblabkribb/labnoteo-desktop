// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react';
import { t } from '../../../i18n/t';
import type { OutlineItem } from '../extract';
import { OutlinePanel } from '../OutlinePanel';
import { clearOutline, publishCursor, publishOutline } from '../outlineStore';

afterEach(() => clearOutline('n.md'));

describe('OutlinePanel', () => {
  it('shows the empty message when the note has no headings', () => {
    render(<OutlinePanel onReveal={() => undefined} />);
    expect(screen.getByText(t('outline.empty'))).toBeTruthy();
    act(() => publishOutline('n.md', []));
    expect(screen.getByText(t('outline.empty'))).toBeTruthy();
  });

  it('outline click puts the cursor on the heading line itself', () => {
    const onReveal = vi.fn();
    render(<OutlinePanel onReveal={onReveal} />);
    act(() => publishOutline('n.md', [{ level: 3, text: 'PCR', code: 'UHW010', kind: 'unitOp', line: 5 }]));
    const tree = screen.getByRole('tree', { name: t('outline.label') });
    expect(tree).toBeTruthy();
    fireEvent.click(screen.getByRole('treeitem', { name: /UHW010 PCR/ }));
    expect(onReveal).toHaveBeenCalledWith('n.md', 4);
  });

  it('activating a parent heading reveals it without collapsing its children', () => {
    const onReveal = vi.fn();
    render(<OutlinePanel onReveal={onReveal} />);
    act(() =>
      publishOutline('n.md', [
        { level: 2, text: 'A', kind: 'heading', line: 2 },
        { level: 3, text: 'B', kind: 'heading', line: 5 },
      ]),
    );
    fireEvent.click(screen.getByRole('treeitem', { name: /A/ }));
    expect(onReveal).toHaveBeenCalledWith('n.md', 1);
    expect(screen.getByRole('treeitem', { name: /B/ })).toBeTruthy();
  });

  it('moving the selection marks the current heading without an edit', () => {
    render(<OutlinePanel onReveal={() => undefined} />);
    act(() =>
      publishOutline('n.md', [
        { level: 2, text: 'A', kind: 'heading', line: 2 },
        { level: 3, text: 'B', kind: 'heading', line: 5 },
      ]),
    );
    act(() => publishCursor('n.md', 7));
    expect(screen.getByRole('treeitem', { name: /B/ }).getAttribute('aria-current')).toBe('true');
    expect(screen.getByRole('treeitem', { name: /A/ }).getAttribute('aria-current')).toBeNull();
    act(() => publishCursor('n.md', 3));
    expect(screen.getByRole('treeitem', { name: /A/ }).getAttribute('aria-current')).toBe('true');
  });

  it('scrolls the current heading into view (nearest) without taking focus', () => {
    const spy = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = spy;
    try {
      render(<OutlinePanel onReveal={() => undefined} />);
      act(() =>
        publishOutline('n.md', [
          { level: 2, text: 'A', kind: 'heading', line: 2 },
          { level: 3, text: 'B', kind: 'heading', line: 5 },
        ]),
      );
      const before = document.activeElement;
      spy.mockClear();
      act(() => publishCursor('n.md', 7));
      const b = screen.getByRole('treeitem', { name: /B/ });
      expect(spy).toHaveBeenCalledWith({ block: 'nearest' });
      expect(spy.mock.contexts.at(-1)).toBe(b);
      expect(document.activeElement).toBe(before);
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  it('a current heading under a collapsed parent marks and scrolls to the parent instead', () => {
    const spy = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = spy;
    try {
      render(<OutlinePanel onReveal={() => undefined} />);
      act(() =>
        publishOutline('n.md', [
          { level: 2, text: 'A', kind: 'heading', line: 2 },
          { level: 3, text: 'B', kind: 'heading', line: 5 },
          { level: 2, text: 'C', kind: 'heading', line: 9 },
        ]),
      );
      fireEvent.keyDown(screen.getByRole('treeitem', { name: /A/ }), { key: 'ArrowLeft' });
      expect(screen.queryByRole('treeitem', { name: /B/ })).toBeNull();
      spy.mockClear();
      act(() => publishCursor('n.md', 7));
      const a = screen.getByRole('treeitem', { name: /A/ });
      expect(a.getAttribute('aria-current')).toBe('true');
      expect(screen.getByRole('treeitem', { name: /C/ }).getAttribute('aria-current')).toBeNull();
      expect(spy.mock.contexts.at(-1)).toBe(a);
      // 펼치면 다시 제 줄이 현재다
      fireEvent.keyDown(a, { key: 'ArrowRight' });
      expect(screen.getByRole('treeitem', { name: /B/ }).getAttribute('aria-current')).toBe('true');
      expect(screen.getByRole('treeitem', { name: /A/ }).getAttribute('aria-current')).toBeNull();
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  it('collapsed headings reset when another note opens', () => {
    render(<OutlinePanel onReveal={() => undefined} />);
    const items: OutlineItem[] = [
      { level: 2, text: 'A', kind: 'heading', line: 2 },
      { level: 3, text: 'B', kind: 'heading', line: 5 },
    ];
    act(() => publishOutline('n.md', items));
    const a = screen.getByRole('treeitem', { name: /A/ });
    fireEvent.keyDown(a, { key: 'ArrowLeft' });
    expect(screen.queryByRole('treeitem', { name: /B/ })).toBeNull();
    act(() => publishOutline('m.md', items));
    expect(screen.getByRole('treeitem', { name: /B/ })).toBeTruthy();
    act(() => clearOutline('m.md'));
  });
});
