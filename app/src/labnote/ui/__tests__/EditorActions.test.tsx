// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createFakeVault } from '../../../__tests__/fakeVault';
import { setLang } from '../../../i18n/lang';
import { createTestHost, type TestHost } from '../../__tests__/testHost';
import { mountEditor } from '../../__tests__/editorHarness';
import { createWorkflow } from '../../commands/workflow';
import { insertUnitOp } from '../../commands/unitOp';
import { showBarcode } from '../../port/barcodeActions';
import { coreT } from '../../i18n';
import { EditorActions, NoteQrButton } from '../EditorActions';

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

describe('EditorActions (the view header primary action)', () => {
  it("is 'UO 추가' on a workflow note, 'Workflow 추가' on a README, and absent elsewhere", async () => {
    const user = userEvent.setup();
    h = createTestHost();
    const { rerender, container } = render(<EditorActions ctx={h.ctx} path={WF_PATH} disabled={false} />);
    const add = screen.getByRole('button', { name: 'UO 추가' });
    expect(add.classList.contains('primary')).toBe(true);
    expect(add.title).toBe(coreT('Insert unit operation'));
    await user.click(add);
    expect(insertUnitOp).toHaveBeenCalledWith(h.ctx);

    rerender(<EditorActions ctx={h.ctx} path={README_PATH} disabled={false} />);
    expect(screen.queryByRole('button', { name: 'UO 추가' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Workflow 추가' }));
    expect(createWorkflow).toHaveBeenCalledWith(h.ctx);

    rerender(<EditorActions ctx={h.ctx} path="notes/a.labnote.md" disabled={false} />);
    expect(container.innerHTML).toBe('');
    rerender(<EditorActions ctx={h.ctx} path="notes/a.md" disabled={false} />);
    expect(container.innerHTML).toBe('');

    // 언어를 바꾸면 다시 그린다
    rerender(<EditorActions ctx={h.ctx} path={WF_PATH} disabled={false} />);
    act(() => setLang('en'));
    expect(screen.getByRole('button', { name: 'Add UO' })).toBeTruthy();
    rerender(<EditorActions ctx={h.ctx} path={README_PATH} disabled={false} />);
    expect(screen.getByRole('button', { name: 'Add workflow' })).toBeTruthy();
    expect(container.querySelectorAll('[style]')).toHaveLength(0);
  });

  it('is disabled while busy', () => {
    h = createTestHost();
    const { rerender } = render(<EditorActions ctx={h.ctx} path={WF_PATH} disabled />);
    expect((screen.getByRole('button', { name: 'UO 추가' }) as HTMLButtonElement).disabled).toBe(true);
    rerender(<EditorActions ctx={h.ctx} path={README_PATH} disabled />);
    expect((screen.getByRole('button', { name: 'Workflow 추가' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('NoteQrButton', () => {
  it('shows the Lucide QR icon button on .labnote.md only, and it is disabled while busy', async () => {
    const user = userEvent.setup();
    h = createTestHost();
    const { rerender, container } = render(<NoteQrButton ctx={h.ctx} path="e/01_x.labnote.md" disabled={false} />);
    const qr = screen.getByRole('button', { name: coreT('Show note barcode') }) as HTMLButtonElement;
    expect(qr.title).toBe(coreT('Show note barcode'));
    expect(qr.classList.contains('editor-qr')).toBe(true);
    expect(qr.querySelector('svg.icon')?.getAttribute('aria-hidden')).toBe('true');
    await user.click(qr);
    expect(showBarcode).toHaveBeenCalledWith(h.ctx, 'e/01_x.labnote.md');

    rerender(<NoteQrButton ctx={h.ctx} path="e/README.md" disabled={false} />);
    expect(container.innerHTML).toBe('');
    rerender(<NoteQrButton ctx={h.ctx} path="e/01_x.labnote.md" disabled />);
    expect((screen.getByRole('button', { name: coreT('Show note barcode') }) as HTMLButtonElement).disabled).toBe(true);
    // Workflow 노트와 README 에도 있다
    rerender(<NoteQrButton ctx={h.ctx} path={WF_PATH} disabled={false} />);
    expect(screen.getByRole('button', { name: coreT('Show note barcode') })).toBeTruthy();
    rerender(<NoteQrButton ctx={h.ctx} path={README_PATH} disabled={false} />);
    expect(screen.getByRole('button', { name: coreT('Show note barcode') })).toBeTruthy();
  });
});

describe('the Editor view header', () => {
  it('renders the primary action before Insert table and passes busy while loading', async () => {
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
    const button = () => screen.getByRole('button', { name: 'UO 추가' }) as HTMLButtonElement;
    const header = button().closest('.view-header')!;
    const names = [...header.querySelectorAll('button')].map((b) => b.getAttribute('aria-label') ?? b.textContent);
    expect(names.indexOf('UO 추가')).toBeLessThan(names.indexOf('표 넣기'));
    expect(button().disabled).toBe(true);
    release();
    await m.loaded();
    await waitFor(() => expect(button().disabled).toBe(false));
    m.unmount();
  });
});
