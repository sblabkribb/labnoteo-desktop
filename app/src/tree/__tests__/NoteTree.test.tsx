// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NoteTree } from '../NoteTree';
import type { TreeEntry } from '../useTree';

const file = (path: string, depth: number): TreeEntry => ({ path, name: path.split('/').pop()!, isDir: false, depth });
const dir = (path: string, depth: number): TreeEntry => ({ path, name: path.split('/').pop()!, isDir: true, depth });

const entries: TreeEntry[] = [
  { path: 'labnote', name: 'labnote', isDir: true, depth: 0 },
  { path: 'labnote/001', name: '001', isDir: true, depth: 1 },
  { path: 'labnote/001/02.md', name: '02.md', isDir: false, depth: 2 },
  { path: 'top.md', name: 'top.md', isDir: false, depth: 0 },
];

describe('노트 트리', () => {
  it('폴더를 접고 펼 수 있다', async () => {
    const user = userEvent.setup();
    render(<NoteTree entries={entries} onSelect={() => {}} />);
    expect(screen.getByText('02')).toBeTruthy();

    await user.click(screen.getByRole('treeitem', { name: 'labnote' }));
    // 하위 폴더와 노트가 모두 사라지고, 같은 깊이의 다른 노트는 남는다.
    expect(screen.queryByText('02')).toBeNull();
    expect(screen.queryByText('001')).toBeNull();
    expect(screen.getByText('top')).toBeTruthy();

    await user.click(screen.getByRole('treeitem', { name: 'labnote' }));
    expect(screen.getByText('02')).toBeTruthy();
  });

  it('깊이는 style 속성이 아니라 data-depth 로 표시한다 (CSP 가 인라인 style 을 막는다)', () => {
    const { container } = render(<NoteTree entries={entries} onSelect={() => {}} />);
    const row = (name: string) => screen.getByText(name).closest('li') as HTMLElement;
    expect(row('02').getAttribute('data-depth')).toBe('2');
    expect(row('top').getAttribute('data-depth')).toBe('0');
    expect(container.querySelector('[style]')).toBeNull();
  });

  it('rows deeper than INDENT_CAP carry .deep and data-depth is clamped to MAX_DEPTH', () => {
    const deep: TreeEntry[] = Array.from({ length: 30 }, (_, d) => ({
      path: Array.from({ length: d + 1 }, (_, i) => `d${i}`).join('/'),
      name: `d${d}`,
      isDir: d < 29,
      depth: d,
    }));
    render(<NoteTree entries={deep} onSelect={() => {}} />);
    const row = (name: string) => screen.getByText(name).closest('li') as HTMLElement;
    expect(row('d8').classList.contains('deep')).toBe(false);
    expect(row('d9').classList.contains('deep')).toBe(true);
    expect(row('d9').classList.contains('wf-tree-row')).toBe(true);
    expect(row('d29').getAttribute('data-depth')).toBe('24');
  });

  it('노트를 고르면 onSelect 에 vault-relative 경로를 넘긴다', async () => {
    const user = userEvent.setup();
    const picked: string[] = [];
    render(<NoteTree entries={entries} onSelect={(p) => picked.push(p)} />);
    await user.click(screen.getByText('02'));
    expect(picked).toEqual(['labnote/001/02.md']);
    // 폴더를 누르는 것은 노트를 고르는 것이 아니다.
    await user.click(screen.getByRole('treeitem', { name: '001' }));
    expect(picked).toEqual(['labnote/001/02.md']);
  });

  it('선택된 노트는 철자의 대소문자가 달라도 같은 노트로 표시된다', () => {
    render(<NoteTree entries={entries} selected="LABNOTE/001/02.MD" onSelect={() => {}} />);
    expect(screen.getByText('02').closest('[aria-current]')?.getAttribute('aria-current')).toBe('true');
    expect(screen.getByText('top').closest('[aria-current]')).toBeNull();
  });

  it('열린 노트의 줄은 styles/tree.css 의 강조 막대 선택자와 맞는다: 열린 줄 하나만 걸린다', () => {
    // styles/tree.css 는 .note-tree [role="treeitem"][aria-current="true"] 에 막대를 그린다. 마크업이 바뀌어 이 선택자가 빗나가면 단서가 조용히 사라진다.
    const { container } = render(<NoteTree entries={entries} selected="labnote/001/02.md" onSelect={() => {}} />);
    const rows = container.querySelectorAll('.note-tree [role="treeitem"][aria-current="true"]');
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toBe('02');
  });

  it('말줄임으로 잘리는 긴 이름은 title 로 전체 이름(경로가 아니라)을 보여 준다', () => {
    const long = '2026-11-06 대장균 BL21 형질전환 효율 비교 실험 — 플라스미드 pET28a 농도별 3반복';
    render(
      <NoteTree
        entries={[
          { path: `실험/${long}`, name: long, isDir: true, depth: 0 },
          { path: `실험/${long}/${long}.labnote.md`, name: `${long}.labnote.md`, isDir: false, depth: 1 },
        ]}
        onSelect={() => {}}
      />,
    );
    // 노트 이름은 .labnote.md 를 뗀 것이라 폴더와 같은 이름으로 보인다: title 이 둘을 가른다
    const [folder, note] = screen.getAllByRole('treeitem', { name: long });
    expect(folder.getAttribute('title')).toBe(long);
    expect(note.getAttribute('title')).toBe(`${long}.labnote.md`);
  });

  it('is a tree with one tab stop and arrow navigation', async () => {
    const user = userEvent.setup();
    render(<NoteTree entries={entries} onSelect={() => {}} />);
    expect(screen.getByRole('tree', { name: '노트' })).toBeTruthy();
    const items = () => screen.getAllByRole('treeitem');
    expect(items()).toHaveLength(4);
    expect(items().filter((e) => e.tabIndex === 0)).toHaveLength(1);
    await user.tab();
    expect(document.activeElement).toBe(items()[0]);
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(items()[1]);
    expect(items().filter((e) => e.tabIndex === 0)).toEqual([items()[1]]);
    await user.keyboard('{End}');
    expect(document.activeElement).toBe(items()[3]);
    await user.keyboard('{Home}');
    expect(document.activeElement).toBe(items()[0]);
    // 왼쪽 화살표는 펼친 폴더를 접는다, 오른쪽은 다시 편다
    await user.keyboard('{ArrowLeft}');
    expect(items()).toHaveLength(2);
    expect(items()[0].getAttribute('aria-expanded')).toBe('false');
    await user.keyboard('{ArrowRight}');
    expect(items()).toHaveLength(4);
  });

  it('Alt, Ctrl or Meta with an arrow is left to the app (history navigation), not taken as tree movement', () => {
    render(<NoteTree entries={entries} onSelect={() => {}} />);
    const items = () => screen.getAllByRole('treeitem');
    const note = screen.getByRole('treeitem', { name: '02' });
    act(() => note.focus());
    for (const mod of [{ altKey: true }, { ctrlKey: true }, { metaKey: true }]) {
      for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End']) {
        const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...mod });
        act(() => void note.dispatchEvent(ev));
        expect(ev.defaultPrevented).toBe(false);
        expect(document.activeElement).toBe(note);
      }
    }
    expect(items()).toHaveLength(4);
  });

  it('Enter on a note row opens it; folders and notes carry their aria-level', async () => {
    const user = userEvent.setup();
    const picked: string[] = [];
    render(<NoteTree entries={entries} onSelect={(p) => picked.push(p)} />);
    const note = screen.getByRole('treeitem', { name: '02' });
    expect(note.getAttribute('aria-level')).toBe('3');
    expect(note.hasAttribute('aria-expanded')).toBe(false);
    act(() => note.focus());
    await user.keyboard('{Enter}');
    expect(picked).toEqual(['labnote/001/02.md']);
  });

  it('the open note starts with its ancestors expanded even after the user collapsed them', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<NoteTree entries={entries} onSelect={() => {}} />);
    await user.click(screen.getByRole('treeitem', { name: 'labnote' }));
    expect(screen.queryByText('02')).toBeNull();
    rerender(<NoteTree entries={entries} selected="labnote/001/02.md" onSelect={() => {}} />);
    expect(screen.getByRole('treeitem', { name: '02' }).getAttribute('aria-current')).toBe('true');
  });

  it('reveal expands a collapsed folder and its ancestors and moves focus to it, once per seq', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<NoteTree entries={entries} onSelect={() => {}} />);
    await user.click(screen.getByRole('treeitem', { name: '001' }));
    await user.click(screen.getByRole('treeitem', { name: 'labnote' }));
    expect(screen.queryByText('001')).toBeNull();
    rerender(<NoteTree entries={entries} onSelect={() => {}} reveal={{ path: 'LabNote/001', seq: 1 }} />);
    const row = screen.getByRole('treeitem', { name: '001' });
    expect(row.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(row);
    expect(row.getAttribute('tabindex')).toBe('0');
  });

  it('노트가 없으면 빈 상태 문구를 보여준다', () => {
    render(<NoteTree entries={[]} onSelect={() => {}} />);
    expect(screen.getByText('노트가 없습니다')).toBeTruthy();
  });

  describe('every file kind (UI redesign Task 9)', () => {
    const vault: TreeEntry[] = [
      dir('labnote', 0),
      dir('labnote/001_PCR', 1),
      dir('labnote/001_PCR/images', 2),
      file('labnote/001_PCR/images/gel.png', 3),
      dir('labnote/001_PCR/resources', 2),
      file('labnote/001_PCR/resources/paper.pdf', 3),
      file('labnote/001_PCR/resources/plate.csv', 3),
      file('labnote/001_PCR/resources/raw.zip', 3),
      file('labnote/001_PCR/01_WD010_Design.labnote.md', 2),
      file('labnote/001_PCR/README.labnote.md', 2),
      file('Plan.md', 0),
    ];
    const row = (name: string) => screen.getByRole('treeitem', { name });
    const icon = (name: string) => row(name).querySelector('svg.tree-icon')!.getAttribute('class')!;

    it('names hide .labnote.md and .md; the title keeps the full file name', () => {
      render(<NoteTree entries={vault} onSelect={() => {}} />);
      expect(row('01_WD010_Design').getAttribute('title')).toBe('01_WD010_Design.labnote.md');
      expect(row('README').getAttribute('title')).toBe('README.labnote.md');
      expect(row('Plan').getAttribute('title')).toBe('Plan.md');
      expect(row('gel.png').getAttribute('title')).toBe('gel.png');
    });

    it('draws a Lucide icon per kind, folder-open while a folder is expanded', async () => {
      const user = userEvent.setup();
      render(<NoteTree entries={vault} onSelect={() => {}} />);
      expect(icon('001_PCR')).toContain('lucide-flask-conical');
      expect(icon('README')).toContain('lucide-flask-conical');
      expect(icon('01_WD010_Design')).toContain('lucide-workflow');
      expect(icon('Plan')).toContain('lucide-file-text');
      expect(icon('gel.png')).toContain('lucide-image');
      expect(icon('plate.csv')).toContain('lucide-sheet');
      expect(icon('paper.pdf')).toContain('lucide-file-type');
      expect(icon('raw.zip')).toContain('lucide-paperclip');
      expect(icon('images')).toContain('lucide-folder-open');
      await user.click(row('images'));
      expect(icon('images')).not.toContain('lucide-folder-open');
      expect(icon('images')).toContain('lucide-folder');
    });

    it('chevrons are Lucide icons on folders only; leaves keep an empty slot', () => {
      const { container } = render(<NoteTree entries={vault} onSelect={() => {}} />);
      expect(row('images').querySelector('.tree-chevron svg')).not.toBeNull();
      expect(row('gel.png').querySelector('.tree-chevron')).not.toBeNull();
      expect(row('gel.png').querySelector('.tree-chevron svg')).toBeNull();
      expect(container.querySelector('[style]')).toBeNull();
    });

    it('attachments without an in-app viewer are dimmed; images and sheets are not', () => {
      render(<NoteTree entries={vault} onSelect={() => {}} />);
      expect(row('paper.pdf').classList.contains('dim')).toBe(true);
      expect(row('raw.zip').classList.contains('dim')).toBe(true);
      expect(row('gel.png').classList.contains('dim')).toBe(false);
      expect(row('plate.csv').classList.contains('dim')).toBe(false);
      expect(row('Plan').classList.contains('dim')).toBe(false);
    });

    it('a note opens in the editor; any other file goes to onView with its kind, never onSelect', async () => {
      const user = userEvent.setup();
      const selected: string[] = [];
      const viewed: [string, string][] = [];
      render(<NoteTree entries={vault} onSelect={(p) => selected.push(p)} onView={(p, k) => viewed.push([p, k])} />);
      await user.click(row('gel.png'));
      await user.click(row('plate.csv'));
      await user.click(row('paper.pdf'));
      await user.click(row('Plan'));
      expect(selected).toEqual(['Plan.md']);
      expect(viewed).toEqual([
        ['labnote/001_PCR/images/gel.png', 'image'],
        ['labnote/001_PCR/resources/plate.csv', 'sheet'],
        ['labnote/001_PCR/resources/paper.pdf', 'pdf'],
      ]);
    });

    it('collapse all folds every folder', () => {
      const ref = { current: undefined as undefined | (() => void) };
      render(<NoteTree entries={vault} onSelect={() => {}} collapseAllRef={ref} />);
      expect(screen.getAllByRole('treeitem')).toHaveLength(vault.length);
      act(() => ref.current!());
      expect(screen.getAllByRole('treeitem').map((e) => e.textContent)).toEqual(['labnote', 'Plan']);
    });
  });
});
