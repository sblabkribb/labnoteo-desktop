// @vitest-environment jsdom
import { fireEvent, render, screen, within } from '@testing-library/react';
import { Ribbon, type RibbonActions } from '../Ribbon';
import { setLang } from '../../i18n/lang';

function actions(): RibbonActions {
  return {
    toggleLeft: vi.fn(),
    quickSwitcher: vi.fn(),
    palette: vi.fn(),
    newExperiment: vi.fn(),
    newNote: vi.fn(),
    scan: vi.fn(),
    toggleRight: vi.fn(),
  };
}

afterEach(() => setLang('ko'));

describe('Ribbon', () => {
  it('renders 7 icon buttons with localised names and shortcut tooltips', () => {
    render(<Ribbon actions={actions()} leftHidden={false} rightOpen={false} ready />);
    const bar = screen.getByRole('toolbar', { name: '리본' });
    expect(bar.getAttribute('aria-orientation')).toBe('vertical');
    const buttons = within(bar).getAllByRole('button');
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual([
      '왼쪽 사이드바 보이기/숨기기',
      '빠른 이동',
      '명령 팔레트',
      '새 실험',
      '새 노트',
      '스캔 가져오기',
      '오른쪽 사이드바 보이기/숨기기',
    ]);
    expect(buttons.map((b) => b.title)).toEqual([
      '왼쪽 사이드바 보이기/숨기기 (Ctrl+\\)',
      '빠른 이동 (Ctrl+O)',
      '명령 팔레트 (Ctrl+P)',
      '새 실험',
      '새 노트 (Ctrl+N)',
      '스캔 가져오기',
      '오른쪽 사이드바 보이기/숨기기 (Ctrl+Shift+\\)',
    ]);
    expect(buttons[buttons.length - 1].getAttribute('aria-keyshortcuts')).toBe('Control+Shift+\\');
    expect(buttons[buttons.length - 1].getAttribute('aria-controls')).toBe('right-dock');
    // 아이콘만: 글자 없이 svg 하나, style 속성 없음(CSP)
    for (const b of buttons) {
      expect(b.textContent).toBe('');
      expect(b.querySelectorAll('svg')).toHaveLength(1);
    }
    expect(bar.querySelectorAll('[style]')).toHaveLength(0);
  });

  it('names follow the language', () => {
    setLang('en');
    render(<Ribbon actions={actions()} leftHidden={false} rightOpen={false} ready />);
    const bar = screen.getByRole('toolbar', { name: 'Ribbon' });
    expect(within(bar).getByRole('button', { name: 'Command palette' }).title).toBe('Command palette (Ctrl+P)');
    expect(within(bar).getByRole('button', { name: 'New note' }).title).toBe('New note (Ctrl+N)');
  });

  it('each button runs its action; the sidebar toggles show their state', () => {
    const a = actions();
    render(<Ribbon actions={a} leftHidden rightOpen ready />);
    const bar = within(screen.getByRole('toolbar', { name: '리본' }));
    const left = bar.getByRole('button', { name: '왼쪽 사이드바 보이기/숨기기' });
    expect(left.getAttribute('aria-expanded')).toBe('false');
    expect(bar.getByRole('button', { name: '오른쪽 사이드바 보이기/숨기기' }).getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(left);
    fireEvent.click(bar.getByRole('button', { name: '새 노트' }));
    fireEvent.click(bar.getByRole('button', { name: '새 실험' }));
    fireEvent.click(bar.getByRole('button', { name: '명령 팔레트' }));
    fireEvent.click(bar.getByRole('button', { name: '빠른 이동' }));
    fireEvent.click(bar.getByRole('button', { name: '스캔 가져오기' }));
    fireEvent.click(bar.getByRole('button', { name: '오른쪽 사이드바 보이기/숨기기' }));
    for (const fn of Object.values(a)) expect(fn).toHaveBeenCalledTimes(1);
  });

  it('commands that need the vault context are disabled until it is ready; the sidebar toggles are not', () => {
    render(<Ribbon actions={actions()} leftHidden={false} rightOpen={false} ready={false} />);
    const bar = within(screen.getByRole('toolbar', { name: '리본' }));
    const disabled = (name: string) => (bar.getByRole('button', { name }) as HTMLButtonElement).disabled;
    expect(disabled('왼쪽 사이드바 보이기/숨기기')).toBe(false);
    expect(disabled('새 노트')).toBe(false);
    expect(disabled('명령 팔레트')).toBe(true);
    expect(disabled('새 실험')).toBe(true);
    expect(disabled('스캔 가져오기')).toBe(true);
  });

  it('Up and Down arrows move focus between the buttons', () => {
    render(<Ribbon actions={actions()} leftHidden={false} rightOpen={false} ready />);
    const buttons = within(screen.getByRole('toolbar', { name: '리본' })).getAllByRole('button');
    buttons[0].focus();
    fireEvent.keyDown(buttons[0], { key: 'ArrowDown' });
    expect(document.activeElement).toBe(buttons[1]);
    fireEvent.keyDown(buttons[1], { key: 'ArrowUp' });
    fireEvent.keyDown(buttons[0], { key: 'ArrowUp' });
    expect(document.activeElement).toBe(buttons[buttons.length - 1]);
  });
});
