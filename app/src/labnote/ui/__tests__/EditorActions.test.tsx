// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createFakeVault } from '../../../__tests__/fakeVault';
import { setLang } from '../../../i18n/lang';
import { createTestHost, type TestHost } from '../../__tests__/testHost';
import { mountEditor } from '../../__tests__/editorHarness';
import { createWorkflow } from '../../commands/workflow';
import { insertUnitOp } from '../../commands/unitOp';
import { showBarcode } from '../../port/barcodeActions';
import { coreT } from '../../i18n';
import { EditorActions } from '../EditorActions';

vi.mock('../../commands/unitOp', () => ({ insertUnitOp: vi.fn(async () => undefined), unitOpCommands: [] }));
vi.mock('../../port/barcodeActions', () => ({ showBarcode: vi.fn(async () => undefined) }));
vi.mock('../../commands/workflow', async (orig) => ({
  ...(await orig<typeof import('../../commands/workflow')>()),
  createWorkflow: vi.fn(async () => undefined),
}));

const DIR = 'labnote/001_A';
const README_PATH = `${DIR}/README.labnote.md`;
const WF_PATH = `${DIR}/001_WD010_General_Design_of_Experiment.labnote.md`;

let h: TestHost;

beforeEach(() => {
  setLang('ko');
  vi.mocked(insertUnitOp).mockClear();
  vi.mocked(createWorkflow).mockClear();
  vi.mocked(showBarcode).mockClear();
});

afterEach(() => {
  cleanup();
  h?.cleanup();
  setLang('ko');
});

describe('EditorActions', () => {
  it("the header shows '유닛 오퍼레이션 삽입' on a workflow note and '워크플로 생성' on a README in ko, and nothing on a plain note", async () => {
    const user = userEvent.setup();
    h = createTestHost();
    const { rerender, container } = render(<EditorActions ctx={h.ctx} path={WF_PATH} disabled={false} />);
    const group = screen.getByRole('group', { name: '노트 작업' });
    await user.click(within(group).getByRole('button', { name: '유닛 오퍼레이션 삽입' }));
    expect(insertUnitOp).toHaveBeenCalledWith(h.ctx);

    rerender(<EditorActions ctx={h.ctx} path={README_PATH} disabled={false} />);
    expect(screen.queryByRole('button', { name: '유닛 오퍼레이션 삽입' })).toBeNull();
    await user.click(screen.getByRole('button', { name: '워크플로 생성' }));
    expect(createWorkflow).toHaveBeenCalledWith(h.ctx);

    // 그 밖의 노트(.labnote.md)에는 바코드 단추만
    rerender(<EditorActions ctx={h.ctx} path="notes/a.labnote.md" disabled={false} />);
    expect(screen.queryByRole('button', { name: '워크플로 생성' })).toBeNull();
    expect(screen.getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual([coreT('Show note barcode')]);
    rerender(<EditorActions ctx={h.ctx} path="notes/a.md" disabled={false} />);
    expect(container.innerHTML).toBe('');

    // 언어를 바꾸면 다시 그린다
    rerender(<EditorActions ctx={h.ctx} path={WF_PATH} disabled={false} />);
    act(() => setLang('en'));
    expect(screen.getByRole('button', { name: 'Insert unit operation' })).toBeTruthy();
    expect(container.querySelectorAll('[style]')).toHaveLength(0);
  });

  it('header shows the QR button on .labnote.md only, and it is disabled while busy', async () => {
    const user = userEvent.setup();
    h = createTestHost();
    const { rerender } = render(<EditorActions ctx={h.ctx} path="e/01_x.labnote.md" disabled={false} />);
    const qr = screen.getByRole('button', { name: coreT('Show note barcode') }) as HTMLButtonElement;
    expect(qr.title).toBe(coreT('Show note barcode'));
    expect(qr.classList.contains('editor-qr')).toBe(true);
    expect(qr.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    await user.click(qr);
    expect(showBarcode).toHaveBeenCalledWith(h.ctx, 'e/01_x.labnote.md');

    rerender(<EditorActions ctx={h.ctx} path="e/README.md" disabled={false} />);
    expect(screen.queryByRole('button', { name: coreT('Show note barcode') })).toBeNull();

    rerender(<EditorActions ctx={h.ctx} path="e/01_x.labnote.md" disabled />);
    expect((screen.getByRole('button', { name: coreT('Show note barcode') }) as HTMLButtonElement).disabled).toBe(true);
    // 워크플로 노트와 README 에도 있다
    rerender(<EditorActions ctx={h.ctx} path={WF_PATH} disabled={false} />);
    expect(screen.getByRole('button', { name: coreT('Show note barcode') })).toBeTruthy();
    rerender(<EditorActions ctx={h.ctx} path={README_PATH} disabled={false} />);
    expect(screen.getByRole('button', { name: coreT('Show note barcode') })).toBeTruthy();
  });

  it('both buttons are disabled while busy', () => {
    h = createTestHost();
    const { rerender } = render(<EditorActions ctx={h.ctx} path={WF_PATH} disabled />);
    expect((screen.getByRole('button', { name: '유닛 오퍼레이션 삽입' }) as HTMLButtonElement).disabled).toBe(true);
    rerender(<EditorActions ctx={h.ctx} path={README_PATH} disabled />);
    expect((screen.getByRole('button', { name: '워크플로 생성' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('the Editor renders headerActions next to Insert table and passes busy while loading', async () => {
    h = createTestHost();
    const vault = createFakeVault({ [WF_PATH]: '# 노트\n' });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const gated = {
      ...vault,
      invoke: (async (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === 'vault_read') await gate;
        return vault.invoke(cmd, args);
      }) as typeof vault.invoke,
    };
    const m = mountEditor(gated, WF_PATH, {
      headerActions: (busy) => <EditorActions ctx={h.ctx} path={WF_PATH} disabled={busy} />,
    });
    const button = () => screen.getByRole('button', { name: '유닛 오퍼레이션 삽입' }) as HTMLButtonElement;
    // "표 넣기" 와 같은 줄
    expect(button().parentElement?.closest('p')?.textContent).toContain('표 넣기');
    expect(button().disabled).toBe(true);
    release();
    await m.loaded();
    await waitFor(() => expect(button().disabled).toBe(false));
    m.unmount();
  });
});
