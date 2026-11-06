// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react';
import { t } from '../../../i18n/t';
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
});
