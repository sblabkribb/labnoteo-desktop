// @vitest-environment jsdom
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef } from 'react';
import { setLang } from '../../../i18n/lang';
import type { AppFs } from '../../../fs/tauriLabnoteFs';
import type { CommandContext } from '../../commands/context';
import { clearCommandsForTest, registerCommand, type Command } from '../../commands/registry';
import { createAppHost } from '../../host/createAppHost';
import { DialogLayer } from '../../host/DialogLayer';
import { closeAllDialogs, currentDialog } from '../../host/dialogStore';
import { clearToasts } from '../../host/toastStore';
import { usePaletteHotkey } from '../CommandPalette';
import { clearAppCommandsForTest, registerAllAppCommands } from '../../../editor/commands/appCommands';
import { getMode, setMode } from '../../../editor/live/mode';

function makeCtx(): CommandContext {
  const host = createAppHost({ fs: {} as AppFs, editTarget: () => undefined, openFile: async () => undefined });
  return {
    host,
    vaultRoot: 'C:/vault',
    settings: {} as CommandContext['settings'],
    updateSettings: () => undefined,
    activePath: () => undefined,
    activeView: () => undefined,
    openFile: async () => undefined,
    closeActive: async () => true,
    refresh: () => undefined,
    showPanel: () => undefined,
  };
}

function Harness({ ctx }: { ctx: CommandContext | undefined }) {
  const shell = useRef<HTMLDivElement>(null);
  usePaletteHotkey(ctx);
  return (
    <>
      <div className="shell" ref={shell}>
        <div data-testid="host" />
      </div>
      <DialogLayer blockRef={shell} />
    </>
  );
}

// Node 의 자체 localStorage 가 jsdom 의 것을 가리므로 메모리 저장소를 꽂는다(theme-guard.test.tsx 와 같다).
function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, String(v)),
    removeItem: (k) => void m.delete(k),
    clear: () => m.clear(),
    key: (i) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    },
  };
}

let run: ReturnType<typeof vi.fn>;
let workflow: Command;
beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
  localStorage.clear();
  setMode('live');
  run = vi.fn(async () => undefined);
  workflow = { id: 'create-workflow', nameKey: 'Create workflow', run };
  registerCommand({ id: 'create-experiment', nameKey: 'Create experiment', run: async () => undefined });
  registerCommand(workflow);
  registerCommand({ id: 'hidden', nameKey: 'Create experiment', run: async () => undefined, available: () => false });
});
afterEach(() => {
  act(() => closeAllDialogs());
  clearCommandsForTest();
  clearAppCommandsForTest();
  clearToasts();
  vi.unstubAllGlobals();
  act(() => setLang('ko'));
});

/** 편집기처럼 그림자 루트 안의 입력 칸에서 키를 친다. 키보드 이벤트는 composed 라 window 까지 올라간다. */
function ctrlPInShadow(init: KeyboardEventInit = {}) {
  const host = screen.getByTestId('host');
  const root = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
  let input = root.querySelector('input');
  if (!input) {
    input = document.createElement('input');
    root.append(input);
  }
  const e = new KeyboardEvent('keydown', { key: 'p', code: 'KeyP', ctrlKey: true, bubbles: true, composed: true, cancelable: true, ...init });
  act(() => {
    input!.dispatchEvent(e);
  });
  return e;
}

const optionLabels = () => screen.queryAllByRole('option').map((o) => o.querySelector('.picker-label')?.textContent);

describe('명령 팔레트', () => {
  it('Ctrl+P opens the palette and prevents default, also when the event starts inside a shadow root', async () => {
    render(<Harness ctx={makeCtx()} />);
    const e = ctrlPInShadow();
    expect(e.defaultPrevented).toBe(true);
    expect(await screen.findByRole('dialog')).toBeTruthy();
    expect(optionLabels()).toEqual(['실험 생성 (Create experiment)', '워크플로 생성 (Create workflow)']);
    // 열려 있는 동안 다시 눌러도 둘째 팔레트를 열지 않는다. 인쇄 대화상자는 여전히 막는다
    const again = ctrlPInShadow();
    expect(again.defaultPrevented).toBe(true);
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
  });

  it('Ctrl+Shift+P and a Korean keyboard layout (key ㅔ, code KeyP) open it too; plain P does not', async () => {
    render(<Harness ctx={makeCtx()} />);
    const plain = ctrlPInShadow({ ctrlKey: false });
    expect(plain.defaultPrevented).toBe(false);
    expect(currentDialog()).toBeNull();
    expect(ctrlPInShadow({ key: 'ㅔ' }).defaultPrevented).toBe(true);
    expect(await screen.findByRole('dialog')).toBeTruthy();
    act(() => closeAllDialogs());
    ctrlPInShadow({ key: 'P', shiftKey: true });
    expect(await screen.findByRole('dialog')).toBeTruthy();
  });

  it("the palette lists Korean names in ko and finds create-workflow by '워크플로 생성' and by 'Create workflow'", async () => {
    const user = userEvent.setup();
    const ctx = makeCtx();
    render(<Harness ctx={ctx} />);
    ctrlPInShadow();
    await user.type(await screen.findByRole('combobox'), '워크플로 생성');
    expect(optionLabels()[0]).toBe('워크플로 생성 (Create workflow)');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(run).toHaveBeenCalledWith(ctx));

    ctrlPInShadow();
    await user.type(await screen.findByRole('combobox'), 'Create workflow');
    expect(optionLabels()[0]).toBe('워크플로 생성 (Create workflow)');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(run).toHaveBeenCalledTimes(2));

    // 영어 화면: 영어 이름만. 이름은 열 때 만든다
    act(() => setLang('en'));
    ctrlPInShadow();
    await screen.findByRole('dialog');
    expect(optionLabels()).toEqual(['Create experiment', 'Create workflow']);
  });

  it('palette lists editor-toggle-source with its shortcut and runs it', async () => {
    const user = userEvent.setup();
    registerAllAppCommands();
    render(<Harness ctx={makeCtx()} />);
    ctrlPInShadow();
    await screen.findByRole('dialog');
    expect(optionLabels().slice(0, 3)).toEqual(['실험 생성 (Create experiment)', '워크플로 생성 (Create workflow)', '소스 보기 전환 (Ctrl+E)']);
    expect(optionLabels()).toContain('굵게 (Ctrl+B)'); // 서식 명령도 앱 명령으로 이어진다(formatCommands.test.tsx)
    await user.type(screen.getByRole('combobox'), 'editor-toggle-source');
    expect(optionLabels()[0]).toBe('소스 보기 전환 (Ctrl+E)');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(getMode()).toBe('source'));

    act(() => setLang('en'));
    ctrlPInShadow();
    await screen.findByRole('dialog');
    expect(optionLabels()).toContain('Toggle source view (Ctrl+E)');
  });
});
