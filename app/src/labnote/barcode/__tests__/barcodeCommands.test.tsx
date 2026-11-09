// @vitest-environment jsdom
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import jsQR from 'jsqr';
import { encodeNotePayload } from '@labnoteo/core/lib/scanPayload';
import { setLang } from '../../../i18n/lang';
import { createTestHost, type TestHost } from '../../__tests__/testHost';
import type { CommandContext } from '../../commands/context';
import { cleanupDialogs, renderLayer, styleAttributes } from '../../host/__tests__/harness';
import { currentDialog } from '../../host/dialogStore';
import { clearToasts, currentToasts } from '../../host/toastStore';
import { coreT } from '../../i18n';
import { openBarcodeDialog } from '../../port/barcodeDialog';
import { QR_QUIET_ZONE } from '../../port/qr';
import { barcodeCommands } from '../commands';
import { NoteIdIndex, setNoteIdIndex } from '../noteIdIndex';

const NOTE = 'e/01_x.labnote.md';
const WF = 'labnote/001_A/001_WD010_General_Design_of_Experiment.labnote.md';
const FILES = { [NOTE]: '---\ntitle: X\n---\n', 'e/README.md': '' };

let h: TestHost;
let ctx: CommandContext;

/** A test host over `files`, with the app's note-ID index built over the same editor-aware fs. */
function setup(files: Record<string, string>, active: string) {
  h = createTestHost(files);
  h.setActive(active);
  ctx = h.ctx;
  setNoteIdIndex(
    new NoteIdIndex({
      files: async () => Object.keys(files).filter((p) => p.endsWith('.md')),
      read: (p) => h.host.fs.read(p),
      ctimes: async (ps) => ps.map(() => 0),
    }),
  );
}

const command = (id: string) => barcodeCommands.find((c) => c.id === id)!;

/** Start a command; the barcode dialog keeps show-note-barcode pending until it closes. */
function run(id: string): Promise<unknown> {
  let p!: Promise<unknown>;
  act(() => {
    p = command(id).run(ctx);
  });
  return p;
}

/** The QR on screen, read back as a module matrix from its one `<path d>` (`M x y h w v1 h-w z` runs). */
function screenMatrix(): boolean[][] {
  const svg = document.querySelector('.barcode-qr svg')!;
  const size = Number(svg.getAttribute('viewBox')!.split(' ')[2]);
  const n = size - 2 * QR_QUIET_ZONE;
  const m = Array.from({ length: n }, () => Array.from({ length: n }, () => false));
  const d = svg.querySelector('path')!.getAttribute('d')!;
  for (const [, x, y, w] of d.matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)) {
    for (let c = 0; c < Number(w); c++) m[Number(y) - QR_QUIET_ZONE][Number(x) - QR_QUIET_ZONE + c] = true;
  }
  return m;
}

/** RGBA pixels of a module matrix with its quiet zone, `scale` px per module. */
function rgba(m: boolean[][], scale = 4): [Uint8ClampedArray, number, number] {
  const width = (m.length + 2 * QR_QUIET_ZONE) * scale;
  const data = new Uint8ClampedArray(width * width * 4);
  for (let y = 0; y < width; y++) {
    for (let x = 0; x < width; x++) {
      const r = Math.floor(y / scale) - QR_QUIET_ZONE;
      const c = Math.floor(x / scale) - QR_QUIET_ZONE;
      const v = r >= 0 && c >= 0 && r < m.length && c < m.length && m[r][c] ? 0 : 255;
      data.set([v, v, v, 255], (y * width + x) * 4);
    }
  }
  return [data, width, width];
}

beforeEach(() => setLang('en'));

afterEach(() => {
  cleanupDialogs();
  clearToasts();
  h?.cleanup();
  setNoteIdIndex(undefined);
  setLang('ko');
  vi.restoreAllMocks();
});

describe('barcode commands', () => {
  it('registers the four commands with the plugin names and availability', () => {
    setup(FILES, NOTE);
    expect(barcodeCommands.map((c) => [c.id, c.nameKey])).toEqual([
      ['show-note-barcode', 'Show note barcode'],
      ['assign-note-id', 'Assign note ID'],
      ['print-experiment-worksheet', 'Print experiment worksheet'],
      ['print-whole-note', 'Print whole note with barcodes'],
    ]);
    const on = (id: string, path: string | undefined) => command(id).available!({ ...ctx, activePath: () => path });
    expect(on('show-note-barcode', 'e/README.md')).toBe(false);
    expect(on('show-note-barcode', undefined)).toBe(false);
    expect(on('show-note-barcode', NOTE)).toBe(true);
    expect(on('assign-note-id', NOTE)).toBe(true);
    expect(on('assign-note-id', 'e/README.md')).toBe(false);
    expect(on('print-whole-note', NOTE)).toBe(true);
    expect(on('print-experiment-worksheet', NOTE)).toBe(false);
    expect(on('print-experiment-worksheet', WF)).toBe(true);
  });

  it('show-note-barcode assigns an ID first and shows the QR of LN1:<id>', async () => {
    setup(FILES, NOTE);
    renderLayer();
    void run('show-note-barcode');
    const dialog = await screen.findByRole('dialog', { name: coreT('Note barcode') });
    const id = /labnote_id: (LN-[0-9A-Z]{8})/.exec(await ctx.host.fs.read(NOTE))![1];
    expect(screen.getByText(id, { selector: 'p' }).classList.contains('barcode-id')).toBe(true);
    expect(dialog.textContent).toContain('X');
    expect(document.querySelector('.barcode-qr svg')).not.toBeNull();
    expect(jsQR(...rgba(screenMatrix()))?.data).toBe('LN1:' + id);
    expect(encodeNotePayload(id)).toBe('LN1:' + id);
    expect(styleAttributes()).toEqual([]);
    // The QR came in through DOMParser and the sanitizer: no foreign attribute survives.
    for (const el of document.querySelectorAll('.barcode-qr *')) {
      expect([...el.attributes].map((a) => a.name).filter((n) => n.startsWith('on') || n === 'style')).toEqual([]);
    }
  });

  it('the dialog offers the worksheet only for workflow notes, and Copy ID writes the clipboard', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    setup({ ...FILES, [WF]: '---\ntitle: W\nlabnote_id: LN-7K3M9QX2\n---\n' }, NOTE);
    renderLayer();
    void run('show-note-barcode');
    await screen.findByRole('dialog', { name: coreT('Note barcode') });
    const id = /labnote_id: (LN-[0-9A-Z]{8})/.exec(await ctx.host.fs.read(NOTE))![1];
    expect(screen.queryByRole('button', { name: coreT('Print experiment worksheet') })).toBeNull();
    expect(screen.getByRole('button', { name: coreT('Print whole note with barcodes') }).classList.contains('primary')).toBe(true);
    await user.click(screen.getByRole('button', { name: coreT('Copy ID') }));
    expect(writeText).toHaveBeenCalledWith(id);
    await waitFor(() => expect(currentToasts().map((x) => [x.kind, x.message])).toContainEqual(['info', coreT('Copied {0}.', id)]));
    cleanupDialogs();

    h.setActive(WF);
    void run('show-note-barcode');
    await screen.findByRole('dialog', { name: coreT('Note barcode') });
    expect(screen.getByText('LN-7K3M9QX2', { selector: 'p' }).classList.contains('barcode-id')).toBe(true);
    expect(screen.getByRole('button', { name: coreT('Print experiment worksheet') }).classList.contains('primary')).toBe(true);
    expect(screen.getByRole('button', { name: coreT('Print whole note with barcodes') }).classList.contains('primary')).toBe(false);
  });

  it('a print button closes the dialog first, then runs its action once', async () => {
    const user = userEvent.setup();
    renderLayer();
    const wholeNote = vi.fn();
    const worksheet = vi.fn();
    let closed = false;
    act(() => {
      void openBarcodeDialog({ title: 'T', id: 'LN-7K3M9QX2' }, { wholeNote, worksheet }).then(() => (closed = true));
    });
    wholeNote.mockImplementation(() => expect(currentDialog()).toBeNull());
    await user.click(screen.getByRole('button', { name: coreT('Print whole note with barcodes') }));
    expect(wholeNote).toHaveBeenCalledTimes(1);
    expect(worksheet).not.toHaveBeenCalled();
    await waitFor(() => expect(closed).toBe(true));
  });

  it('assign-note-id with a unique ID only says so', async () => {
    const text = '---\ntitle: X\nlabnote_id: LN-7K3M9QX2\n---\n\nbody\n';
    setup({ [NOTE]: text }, NOTE);
    await run('assign-note-id');
    expect(h.notes).toEqual([{ kind: 'info', message: coreT('This note already has the note ID {0}.', 'LN-7K3M9QX2') }]);
    expect(h.asked.confirm).toEqual([]);
    expect(await ctx.host.fs.read(NOTE)).toBe(text);
  });

  it('assign-note-id with a shared ID asks and re-numbers on Give a new ID', async () => {
    const a = '---\ntitle: A\nlabnote_id: LN-7K3M9QX2\n---\n';
    const B = 'e/02_b.labnote.md';
    setup({ [NOTE]: a, [B]: '---\ntitle: B\nlabnote_id: LN-7K3M9QX2\n---\n' }, B);
    h.answer.confirm(true);
    await run('assign-note-id');
    expect(h.asked.confirm).toEqual([
      {
        message: coreT('{0} also has the note ID {1}. Give this note a new ID?', NOTE, 'LN-7K3M9QX2'),
        opts: { confirmLabel: coreT('Give a new ID') },
      },
    ]);
    const id = /labnote_id: (LN-[0-9A-Z]{8})/.exec(await ctx.host.fs.read(B))![1];
    expect(id).not.toBe('LN-7K3M9QX2');
    expect(await ctx.host.fs.read(NOTE)).toBe(a);
    expect(h.notes).toEqual([{ kind: 'info', message: coreT('{0} now has the note ID {1}.', '02_b.labnote', id) }]);
  });

  it('assign-note-id with a shared ID changes nothing when the question is declined', async () => {
    const b = '---\ntitle: B\nlabnote_id: LN-7K3M9QX2\n---\n';
    const B = 'e/02_b.labnote.md';
    setup({ [NOTE]: '---\ntitle: A\nlabnote_id: LN-7K3M9QX2\n---\n', [B]: b }, B);
    h.answer.confirm(false);
    await run('assign-note-id');
    expect(await ctx.host.fs.read(B)).toBe(b);
    expect(h.notes).toEqual([]);
  });
});
