// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setLang } from '../../i18n/lang';
import { clearEditorStatus, countWords, publishEditorStatus } from '../../editor/editorStatus';
import { notePosition } from '../../labnote/notePosition';
import { noteWrites } from '../../labnote/openNotes';
import { Breadcrumb, NoteLead, StatusChip, type WorkflowTickIo } from '../Breadcrumb';
import { NavButtons } from '../ViewHeader';
import { StatusBar } from '../StatusBar';
import { SelectMenu } from '../SelectMenu';
import { Segmented } from '../Segmented';

vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));

const EXP = 'labnote/003_E_coli_host';
const WF = `${EXP}/002_WT020_Protein_Expression_Measurement_GFP.labnote.md`;
const WF_TEXT = [
  '## [WT020 Protein Expression Measurement] GFP',
  '',
  '### [UHW180 Incubation]',
  "- End_date: '2026-11-09 08:00'",
  '',
  '### [UHW380 Microplate Reading] plate 1',
  "- Start_date: '2026-11-09 09:00'",
  "- End_date: ''",
  '',
].join('\n');

afterEach(() => {
  cleanup();
  setLang('ko');
  clearEditorStatus(WF);
  clearEditorStatus(`${EXP}/README.labnote.md`);
  clearEditorStatus(`${EXP}/README.md`);
  clearEditorStatus('a/b.md');
});

describe('Breadcrumb', () => {
  it('renders experiment › workflow; the last segment opens a UO menu whose choice jumps to the heading', async () => {
    const onOpen = vi.fn();
    const onJump = vi.fn();
    const onMenu = vi.fn();
    render(<Breadcrumb position={notePosition(WF, WF_TEXT, { now: '2026-11-10 12:00' })} onOpen={onOpen} onJump={onJump} onMenu={onMenu} />);
    const nav = screen.getByRole('navigation', { name: '노트 위치' });
    expect(nav.textContent).toBe('003E coli hostWT020GFP');
    expect([...nav.querySelectorAll('li')].map((li) => li.getAttribute('aria-hidden'))).toEqual([null, 'true', null]);
    await userEvent.click(within(nav).getByRole('button', { name: /E coli host/ }));
    expect(onOpen).toHaveBeenCalledWith(`${EXP}/README.labnote.md`);
    const last = within(nav).getByRole('button', { name: /WT020/ });
    expect(last.getAttribute('aria-haspopup')).toBe('menu');
    await userEvent.click(last);
    const [anchor, items] = onMenu.mock.calls[0];
    expect(anchor).toBe(last);
    expect(items.map((i: { label: string }) => i.label)).toEqual(['Incubation', 'plate 1']);
    expect(items.map((i: { icon?: string; shortcut?: string }) => [i.icon, i.shortcut])).toEqual([
      ['circle-check', 'UHW180'],
      ['circle-dot', 'UHW380'],
    ]);
    await items[1].run();
    expect(onJump).toHaveBeenCalledWith(5);
    // Workflow 에는 계산한 상태 칩 대신 UO 진행 칩: 완료 표시는 README 체크 하나뿐이라 서로 엇갈리지 않는다
    expect(screen.getByText('Unit Operation 1/2').className).toBe('chip code');
    expect(document.querySelector('.chip.status')).toBeNull();
  });

  it('a workflow note shows a Workflow done checkbox chip that toggles; disabled when the checklist has no entry', async () => {
    const onToggle = vi.fn();
    const props = { onOpen: vi.fn(), onJump: vi.fn(), onMenu: vi.fn(), onToggleWorkflowDone: onToggle };
    const pos = notePosition(WF, WF_TEXT, { now: '2026-11-10 12:00' });
    const { rerender } = render(<Breadcrumb {...props} position={pos} workflowTicked={false} />);
    const box = screen.getByRole('checkbox', { name: 'Workflow 완료' });
    expect(box.getAttribute('aria-checked')).toBe('false');
    expect(box.getAttribute('title')).toMatch(/^Workflow 완료로 표시하기/);
    await userEvent.click(box);
    expect(onToggle).toHaveBeenCalledTimes(1);
    rerender(<Breadcrumb {...props} position={pos} workflowTicked={true} />);
    expect(screen.getByRole('checkbox', { name: 'Workflow 완료' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('checkbox', { name: 'Workflow 완료' }).getAttribute('data-shape')).toBe('check');
    rerender(<Breadcrumb {...props} position={pos} workflowTicked={undefined} />);
    const missing = screen.getByRole('checkbox', { name: 'Workflow 완료' }) as HTMLButtonElement;
    expect(missing.disabled).toBe(true);
    expect(missing.getAttribute('title')).toContain('폴더와 Workflow 체크리스트 맞추기');
    // 읽는 중이면 그리지 않는다
    rerender(<Breadcrumb {...props} position={pos} workflowTicked="loading" />);
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('NoteLead reads the README tick, toggles it, and re-reads when the app writes the README', async () => {
    publishEditorStatus(WF, { text: WF_TEXT, save: 'saved' });
    let ticked = false;
    const io: WorkflowTickIo = {
      read: vi.fn(async () => ticked),
      toggle: vi.fn(async () => (ticked = !ticked)),
    };
    render(<NoteLead path={WF} onOpen={vi.fn()} onJump={vi.fn()} onMenu={vi.fn()} workflowTick={io} />);
    const box = await screen.findByRole('checkbox', { name: 'Workflow 완료' });
    expect(io.read).toHaveBeenCalledWith(WF);
    expect(box.getAttribute('aria-checked')).toBe('false');
    await userEvent.click(box);
    expect(io.toggle).toHaveBeenCalledWith(WF);
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Workflow 완료' }).getAttribute('aria-checked')).toBe('true'));
    // 다른 곳(실험 탭)에서 README 를 고치면 다시 읽는다
    ticked = false;
    act(() => noteWrites.emit(`${EXP}/README.labnote.md`));
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Workflow 완료' }).getAttribute('aria-checked')).toBe('false'));
    // 다른 노트의 쓰기는 보지 않는다
    const reads = vi.mocked(io.read).mock.calls.length;
    act(() => noteWrites.emit('labnote/004_Plan/README.labnote.md'));
    expect(vi.mocked(io.read).mock.calls.length).toBe(reads);
  });

  it('NoteLead re-reads for a legacy README.md and when an open README editor changes its unsaved text', async () => {
    publishEditorStatus(WF, { text: WF_TEXT, save: 'saved' });
    let ticked: boolean | undefined = false;
    const io: WorkflowTickIo = { read: vi.fn(async () => ticked), toggle: vi.fn(async () => undefined) };
    render(<NoteLead path={WF} onOpen={vi.fn()} onJump={vi.fn()} onMenu={vi.fn()} workflowTick={io} />);
    await screen.findByRole('checkbox', { name: 'Workflow 완료' });
    // 예전 보관함의 README.md 에 쓴 것
    ticked = true;
    act(() => noteWrites.emit(`${EXP}/README.md`));
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Workflow 완료' }).getAttribute('aria-checked')).toBe('true'));
    // 편집기에 열린 README 의 저장하지 않은 글이 바뀌면 다시 읽는다(읽기는 그 버퍼를 본다)
    ticked = false;
    act(() => publishEditorStatus(`${EXP}/README.md`, { text: '## Related Workflows\n\n[ ] [GFP](./002_WT020_Protein_Expression_Measurement_GFP.labnote.md)\n', save: 'dirty' }));
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Workflow 완료' }).getAttribute('aria-checked')).toBe('false'));
    const reads = vi.mocked(io.read).mock.calls.length;
    // 커서만 움직인 것(같은 글), 다른 실험의 README 는 다시 읽지 않는다
    act(() => publishEditorStatus(`${EXP}/README.md`, { line: 3, col: 2 }));
    act(() => publishEditorStatus('labnote/004_Plan/README.md', { text: 'x', save: 'dirty' }));
    act(() => noteWrites.emit('labnote/004_Plan/README.md'));
    expect(vi.mocked(io.read).mock.calls.length).toBe(reads);
    clearEditorStatus('labnote/004_Plan/README.md');
  });

  it('a workflow with no UO offers a disabled hint in the menu', async () => {
    const onMenu = vi.fn();
    render(<Breadcrumb position={notePosition(WF, '')} onOpen={vi.fn()} onJump={vi.fn()} onMenu={onMenu} />);
    await userEvent.click(screen.getByRole('button', { name: /WT020/ }));
    expect(onMenu.mock.calls[0][1]).toEqual([expect.objectContaining({ label: '아직 Unit Operation이 없습니다', disabled: true })]);
  });

  it('a README shows the experiment, a "Workflow 1/3" chip and a status chip that runs the status command', async () => {
    const onStatus = vi.fn();
    const text = '---\nstatus: planned\n---\n## 🗂️ Related Workflows\n\n- [x] [A](./001_WA010_A.labnote.md)\n- [ ] [B](./002_WB010_B.labnote.md)\n- [ ] [C](./003_WC010_C.labnote.md)\n';
    render(<Breadcrumb position={notePosition(`${EXP}/README.labnote.md`, text)} onOpen={vi.fn()} onJump={vi.fn()} onMenu={vi.fn()} onStatus={onStatus} />);
    expect(screen.getByText('Workflow 1/3')).toBeTruthy();
    const chip = screen.getByRole('button', { name: '계획' });
    expect(chip.getAttribute('data-shape')).toBe('dashed');
    await userEvent.click(chip);
    expect(onStatus).toHaveBeenCalled();
  });

  it('a plain note shows its folder path, then its title', () => {
    render(<Breadcrumb position={notePosition('Protocols/PCR/Colony PCR.labnote.md', '')} onOpen={vi.fn()} onJump={vi.fn()} onMenu={vi.fn()} />);
    const nav = screen.getByRole('navigation', { name: '노트 위치' });
    expect(nav.textContent).toBe('ProtocolsPCRColony PCR');
    expect(within(nav).getByText('Colony PCR').getAttribute('aria-current')).toBe('page');
  });
});

describe('StatusChip', () => {
  it('shows the localised label and the shape, in ko and en', () => {
    const { rerender, container } = render(<StatusChip status="completed" />);
    expect(container.textContent).toBe('완료');
    expect(container.querySelector('.chip')?.getAttribute('data-shape')).toBe('check');
    expect(container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    act(() => setLang('en'));
    rerender(<StatusChip status="in-progress" />);
    expect(container.textContent).toBe('In progress');
    expect(container.querySelector('.chip')?.getAttribute('title')).toBe('Status: In progress');
  });
});

describe('NavButtons', () => {
  it('back and forward are disabled when there is nowhere to go', async () => {
    const onBack = vi.fn();
    const { rerender } = render(<NavButtons canBack={false} canForward={false} onBack={onBack} onForward={vi.fn()} />);
    expect((screen.getByRole('button', { name: '뒤로' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '앞으로' }) as HTMLButtonElement).disabled).toBe(true);
    rerender(<NavButtons canBack canForward={false} onBack={onBack} onForward={vi.fn()} />);
    const back = screen.getByRole('button', { name: '뒤로' });
    expect(back.title).toBe('뒤로 (Alt+←)');
    await userEvent.click(back);
    expect(onBack).toHaveBeenCalled();
  });
});

describe('StatusBar', () => {
  it('shows "WT020 · UO 1/2 완료", the save state, the line and column and the word count', async () => {
    const onReveal = vi.fn();
    render(<StatusBar path={WF} onReveal={onReveal} />);
    expect(document.querySelector('.statusbar')?.textContent).toBe('');
    act(() => publishEditorStatus(WF, { text: WF_TEXT, words: countWords(WF_TEXT), line: 3, col: 5, save: 'saved' }));
    const bar = within(screen.getByRole('contentinfo', { name: '상태 표시줄' }));
    await userEvent.click(bar.getByRole('button', { name: /WT020 · UO 1\/2 완료/ }));
    expect(onReveal).toHaveBeenCalled();
    expect(bar.getByText('저장됨')).toBeTruthy();
    expect(bar.getByText('줄 3, 열 5')).toBeTruthy();
    expect(bar.getByText(`단어 ${countWords(WF_TEXT)}`)).toBeTruthy();
    act(() => publishEditorStatus(WF, { save: 'dirty' }));
    expect(bar.getByText('저장 안 됨')).toBeTruthy();
    act(() => publishEditorStatus(WF, { save: 'saving' }));
    expect(bar.getByText('저장 중…').parentElement?.querySelector('svg')?.classList.contains('spin')).toBe(true);
    act(() => publishEditorStatus(WF, { save: 'error' }));
    expect(bar.getByText('저장 실패').parentElement?.getAttribute('data-tone')).toBe('danger');
    act(() => setLang('en'));
    expect(bar.getByText('Ln 3, Col 5')).toBeTruthy();
    expect(bar.getByText('Not saved')).toBeTruthy();
  });

  it('a README shows "003 · Workflow 1/3"; another note no position; another path is ignored', () => {
    const readme = `${EXP}/README.labnote.md`;
    const { rerender } = render(<StatusBar path={readme} onReveal={vi.fn()} />);
    act(() => publishEditorStatus(readme, { text: '## Related Workflows\n\n- [x] [A](./001_WA010_A.labnote.md)\n- [ ] [B](./002_WB010_B.labnote.md)\n- [ ] [C](./003_WC010_C.labnote.md)\n', save: 'saved' }));
    expect(screen.getByRole('button', { name: /003 · Workflow 1\/3/ })).toBeTruthy();
    rerender(<StatusBar path="a/b.md" onReveal={vi.fn()} />);
    act(() => publishEditorStatus('a/b.md', { text: 'x y', words: 2, save: 'saved' }));
    expect(document.querySelector('.statusbar-position')).toBeNull();
    expect(screen.getByText('단어 2')).toBeTruthy();
    rerender(<StatusBar path="other.md" onReveal={vi.fn()} />);
    expect(screen.queryByText('단어 2')).toBeNull();
  });
});

describe('countWords', () => {
  it('skips front matter and counts chunks with letters or digits', () => {
    expect(countWords('---\ntitle: x y z\n---\n# 제목\n- 하나 둘 | 3 |')).toBe(4);
    expect(countWords('')).toBe(0);
  });
});

describe('SelectMenu', () => {
  const OPTIONS = [
    { value: 'ko', label: '한국어', lang: 'ko' },
    { value: 'en', label: 'English', lang: 'en' },
  ] as const;

  it('is a listbox button: arrows, Enter, Esc and type-ahead', async () => {
    const onChange = vi.fn();
    render(<SelectMenu label="언어" value="ko" options={OPTIONS} onChange={onChange} />);
    const button = screen.getByRole('button', { name: '언어: 한국어' });
    expect(button.getAttribute('aria-haspopup')).toBe('listbox');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    fireEvent.keyDown(button, { key: 'ArrowDown' });
    const list = screen.getByRole('listbox', { name: '언어' });
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(within(list).getByRole('option', { name: '한국어' }).getAttribute('aria-selected')).toBe('true');
    expect(within(list).getByRole('option', { name: 'English' }).getAttribute('lang')).toBe('en');
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    fireEvent.keyDown(list, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('en');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(document.activeElement).toBe(button);
    // 글자로 찾기
    await userEvent.click(button);
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'e' });
    fireEvent.keyDown(screen.getByRole('listbox'), { key: ' ' });
    expect(onChange).toHaveBeenLastCalledWith('en');
    // Esc 는 고르지 않고 닫는다
    onChange.mockClear();
    await userEvent.click(button);
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('Segmented', () => {
  it('is a radiogroup with roving tabindex; arrows choose', () => {
    const onChange = vi.fn();
    render(
      <Segmented
        label="테마"
        value="light"
        onChange={onChange}
        options={[
          { value: 'system', label: '시스템' },
          { value: 'light', label: '밝게' },
          { value: 'dark', label: '어둡게' },
        ]}
      />,
    );
    const radios = within(screen.getByRole('radiogroup', { name: '테마' })).getAllByRole('radio');
    expect(radios.map((r) => r.tabIndex)).toEqual([-1, 0, -1]);
    fireEvent.keyDown(radios[1], { key: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith('dark');
    fireEvent.keyDown(radios[1], { key: 'ArrowLeft' });
    expect(onChange).toHaveBeenLastCalledWith('system');
  });
});

describe('CSP: no style attributes or React style props in the new chrome', () => {
  it('the sources set positions only through the CSSOM', () => {
    for (const f of ['ViewHeader.tsx', 'Breadcrumb.tsx', 'StatusBar.tsx', 'AppearancePopover.tsx', 'Popover.tsx', 'SelectMenu.tsx', 'Segmented.tsx']) {
      expect(readFileSync(resolve(__dirname, '..', f), 'utf8'), f).not.toMatch(/style=/);
    }
    expect(readFileSync(resolve(__dirname, '..', 'Popover.tsx'), 'utf8')).toMatch(/style\.setProperty\('left'/);
  });
});
