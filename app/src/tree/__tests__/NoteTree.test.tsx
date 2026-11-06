// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NoteTree } from '../NoteTree';
import type { TreeEntry } from '../useTree';

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
    expect(screen.getByText('02.md')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: /labnote/ }));
    // 하위 폴더와 노트가 모두 사라지고, 같은 깊이의 다른 노트는 남는다.
    expect(screen.queryByText('02.md')).toBeNull();
    expect(screen.queryByText('001')).toBeNull();
    expect(screen.getByText('top.md')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: /labnote/ }));
    expect(screen.getByText('02.md')).toBeTruthy();
  });

  it('깊이는 style 속성이 아니라 data-depth 로 표시한다 (CSP 가 인라인 style 을 막는다)', () => {
    const { container } = render(<NoteTree entries={entries} onSelect={() => {}} />);
    const row = (name: string) => screen.getByText(name).closest('li') as HTMLElement;
    expect(row('02.md').getAttribute('data-depth')).toBe('2');
    expect(row('top.md').getAttribute('data-depth')).toBe('0');
    expect(container.querySelector('[style]')).toBeNull();
  });

  it('노트를 고르면 onSelect 에 vault-relative 경로를 넘긴다', async () => {
    const user = userEvent.setup();
    const picked: string[] = [];
    render(<NoteTree entries={entries} onSelect={(p) => picked.push(p)} />);
    await user.click(screen.getByText('02.md'));
    expect(picked).toEqual(['labnote/001/02.md']);
    // 폴더를 누르는 것은 노트를 고르는 것이 아니다.
    await user.click(screen.getByRole('button', { name: /001/ }));
    expect(picked).toEqual(['labnote/001/02.md']);
  });

  it('선택된 노트는 철자의 대소문자가 달라도 같은 노트로 표시된다', () => {
    render(<NoteTree entries={entries} selected="LABNOTE/001/02.MD" onSelect={() => {}} />);
    expect(screen.getByText('02.md').closest('[aria-current]')?.getAttribute('aria-current')).toBe('true');
    expect(screen.getByText('top.md').closest('[aria-current]')).toBeNull();
  });

  it('열린 노트의 줄은 app.css 의 강조 막대 선택자와 맞는다: 열린 줄 하나만 걸린다', () => {
    // app.css 는 li:has(> button[aria-current="true"]) 에 막대를 그린다. 마크업이 바뀌어 이 선택자가 빗나가면 단서가 조용히 사라진다.
    const { container } = render(<NoteTree entries={entries} selected="labnote/001/02.md" onSelect={() => {}} />);
    const rows = container.querySelectorAll('li:has(> button[aria-current="true"])');
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toBe('02.md');
  });

  it('노트가 없으면 빈 상태 문구를 보여준다', () => {
    render(<NoteTree entries={[]} onSelect={() => {}} />);
    expect(screen.getByText('노트가 없습니다')).toBeTruthy();
  });
});
