// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { createTranslator } from '@labnoteo/core';
import type { PagePayload } from '@labnoteo/core/lib/scanPayload';
import { setLang } from '../../../i18n/lang';
import { t as appT } from '../../../i18n/t';
import type { ProgressHandle } from '../../../integrations/progressStore';
import { createTestHost } from '../../__tests__/testHost';
import type { CommandContext } from '../../commands/context';
import { cleanupDialogs, renderLayer, styleAttributes } from '../../host/__tests__/harness';
import { currentDialog } from '../../host/dialogStore';
import { clearToasts, currentToasts } from '../../host/toastStore';
import { coreT, overrideOr } from '../../i18n';
import type { PageDecoder, ScanInput, ScanPipeline, ScanResult } from '../../port/scanPipeline';
import { describeResult, summarizeResults, unmatchedReasonText } from '../../port/scanResults';
import { ScanFeature, scanFeature, setScanFeature, type ScanFeatureDeps } from '../scanFeature';

const ID = 'LN-7K3M9QX2';
const NOTE = 'e/01_x.labnote.md';
const PAYLOAD: PagePayload = {
  noteId: ID,
  unitOpIndex: 1,
  opId: 'UHW010',
  page: 1,
  pageCount: 1,
  printedOn: '2026-01-01',
};
/** The scan entry comment for hash 'ab12' is on line 7 (0-based), as core scanEntryLine counts. */
const NOTE_TEXT = [
  '---',
  `labnote_id: ${ID}`,
  '---',
  '### [UHW010 PCR] amp',
  '',
  '#### Worksheet scans',
  '',
  '<!-- labnoteo-scan page=1/1 sha=ab12 -->',
  '![[x.jpg|200]]',
  '',
].join('\n');

const filed = (over: Partial<ScanResult> = {}): ScanResult => ({
  source: 'a.jpg',
  status: 'filed',
  payload: PAYLOAD,
  notePath: NOTE,
  imagePath: 'e/scans/x.jpg',
  hash: 'ab12',
  block: '[UHW010 PCR] amp',
  matchedBy: 'index',
  ...over,
});

const ACCEPT = /const ACCEPT = '([^']*)';/.exec(readFileSync('vendor/labnoteo/src/scan/importModal.ts', 'utf-8'))![1];

/** jsdom's File has no arrayBuffer(); WebView2's has. Read through FileReader in the test only. */
beforeAll(() => {
  if (typeof Blob.prototype.arrayBuffer === 'function') return;
  Object.defineProperty(Blob.prototype, 'arrayBuffer', {
    configurable: true,
    value(this: Blob) {
      return new Promise<ArrayBuffer>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result as ArrayBuffer);
        r.onerror = () => reject(r.error);
        r.readAsArrayBuffer(this);
      });
    },
  });
});

let ctx: CommandContext;
let pipeline: ScanPipeline & {
  run: ReturnType<typeof vi.fn>;
  undo: ReturnType<typeof vi.fn>;
  removePrevious: ReturnType<typeof vi.fn>;
};
let progressLines: string[];
let withProgressSpy: ReturnType<typeof vi.fn>;

function fakePipeline(results: ScanResult[] = [filed()]) {
  return {
    run: vi.fn(async (_inputs: readonly ScanInput[], _opts?: unknown) => results),
    undo: vi.fn(async (r: ScanResult) => r.status === 'filed'),
    removePrevious: vi.fn(async (r: ScanResult) => {
      const n = r.previous?.length ?? 0;
      r.previous = [];
      return n;
    }),
  } as unknown as typeof pipeline;
}

function makeFeature(deps: Partial<ScanFeatureDeps> = {}): ScanFeature {
  return new ScanFeature(ctx, {
    pipeline,
    decoder: { expand: vi.fn() } as unknown as PageDecoder,
    withProgress: withProgressSpy as unknown as ScanFeatureDeps['withProgress'],
    ...deps,
  });
}

beforeEach(() => {
  setLang('en');
  const h = createTestHost({ [NOTE]: NOTE_TEXT });
  ctx = h.ctx;
  pipeline = fakePipeline();
  progressLines = [];
  withProgressSpy = vi.fn(async (_title: string, run: (p: ProgressHandle) => Promise<unknown>) =>
    run({
      signal: new AbortController().signal,
      line: (s: string) => void progressLines.push(s),
      done: () => {},
    }),
  );
});

afterEach(() => {
  cleanupDialogs();
  act(() => clearToasts());
  setScanFeature(undefined);
  act(() => setLang('ko'));
});

/** Run `fn` inside act and hand back its promise. */
function inAct<R>(fn: () => Promise<R>): Promise<R> {
  let p!: Promise<R>;
  act(() => {
    p = fn();
  });
  return p;
}

describe('import dialog', () => {
  it('dropping files reads their bytes and runs one batch', async () => {
    renderLayer();
    const feature = makeFeature();
    const done = inAct(() => feature.openImport());
    const zone = document.querySelector('.scan-drop')!;
    expect(zone).toBeTruthy();
    fireEvent.dragOver(zone, { dataTransfer: { files: [] } });
    expect(zone.classList.contains('over')).toBe(true);
    const a = new File(['ab'], 'a.jpg');
    const b = new File(['cd'], 'b.pdf');
    await act(async () => {
      fireEvent.drop(zone, { dataTransfer: { files: [a, b] } });
      await done;
    });
    expect(pipeline.run).toHaveBeenCalledTimes(1);
    const inputs = pipeline.run.mock.calls[0][0] as ScanInput[];
    expect(inputs.map((i) => [i.name, [...new Uint8Array(i.bytes)]])).toEqual([
      ['a.jpg', [97, 98]],
      ['b.pdf', [99, 100]],
    ]);
    // a manual run: the progress dialog, then the results dialog
    expect(withProgressSpy).toHaveBeenCalledWith(coreT('Processing scans…'), expect.any(Function));
    expect(currentDialog()?.spec.kind).toBe('scanResults');
    expect(styleAttributes()).toEqual([]);
  });

  it('the file picker accepts the plugin ACCEPT list', async () => {
    renderLayer();
    const feature = makeFeature();
    const done = inAct(() => feature.openImport());
    const input = document.querySelector<HTMLInputElement>('input[type=file]')!;
    expect(input.multiple).toBe(true);
    expect(input.getAttribute('accept')).toBe(ACCEPT);
    expect(input.hidden).toBe(true);
    // the zone is a button that opens the picker
    const click = vi.spyOn(input, 'click').mockImplementation(() => {});
    fireEvent.click(document.querySelector('.scan-drop')!);
    expect(click).toHaveBeenCalledTimes(1);
    // choosing files runs them like a drop
    Object.defineProperty(input, 'files', {
      configurable: true,
      value: [new File(['x'], 'c.png')],
    });
    await act(async () => {
      fireEvent.change(input);
      await done;
    });
    expect((pipeline.run.mock.calls[0][0] as ScanInput[]).map((i) => i.name)).toEqual(['c.png']);
    expect(screen.getByRole('dialog', { name: coreT('Scan results') })).toBeTruthy();
  });

  it('closing the import dialog runs nothing', async () => {
    renderLayer();
    const feature = makeFeature();
    const done = inAct(() => feature.openImport());
    fireEvent.click(screen.getByRole('button', { name: appT('dialog.close') }));
    await act(async () => {
      await done;
    });
    expect(pipeline.run).not.toHaveBeenCalled();
    expect(currentDialog()).toBeNull();
  });
});

describe('results dialog', () => {
  it('results list Open note, Delete earlier scan and Undo per row', async () => {
    renderLayer();
    pipeline = fakePipeline();
    const result = filed({
      previous: [{ hash: 'cd34', embed: '![[old.jpg|200]]' }],
    });
    const feature = makeFeature();
    act(() => feature.report([result], true));
    const dialog = screen.getByRole('dialog', { name: coreT('Scan results') });
    expect(dialog.textContent).toContain(summarizeResults(coreT, [result]));
    const row = dialog.querySelector('.scan-results li')!;
    expect(row.textContent).toContain('a.jpg — LN-7K3M9QX2 · UHW010 · 1/1');
    expect(
      within(row as HTMLElement)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual([coreT('Open note'), coreT('Delete earlier scan'), coreT('Undo')]);

    // Delete earlier scan: removes, says how many, and the button is spent
    const del = within(row as HTMLElement).getByRole('button', {
      name: coreT('Delete earlier scan'),
    });
    await act(async () => {
      fireEvent.click(del);
    });
    expect(pipeline.removePrevious).toHaveBeenCalledWith(result);
    expect(currentToasts().map((x) => x.message)).toContain(coreT('Removed {0} earlier scan(s).', '1'));
    expect((del as HTMLButtonElement).disabled).toBe(true);

    // Undo: the row says Undone and loses its buttons
    await act(async () => {
      fireEvent.click(within(row as HTMLElement).getByRole('button', { name: coreT('Undo') }));
    });
    expect(pipeline.undo).toHaveBeenCalledWith(result);
    expect(currentToasts().map((x) => x.message)).toContain(coreT('Removed the scan from {0}.', NOTE));
    expect(row.textContent).toContain(coreT('Undone'));
    expect(within(row as HTMLElement).queryAllByRole('button')).toEqual([]);
    expect(result.status).toBe('skipped');
    expect(styleAttributes()).toEqual([]);
  });

  it('a duplicate row has only Open note; an unmatched result offers Assign unmatched scans', () => {
    renderLayer();
    const feature = makeFeature();
    // The queue itself is unmatched.test.tsx's: here only that the results hand over to it.
    const openUnmatched = vi.spyOn(feature, 'openUnmatched').mockResolvedValue(undefined);
    act(() =>
      feature.report(
        [
          {
            source: 'd.jpg',
            status: 'duplicate',
            notePath: NOTE,
            hash: 'ef56',
            payload: PAYLOAD,
          },
          { source: 'u.jpg', status: 'unmatched', reason: 'no-qr' },
          { source: 's.jpg', status: 'skipped' },
        ],
        true,
      ),
    );
    const rows = [...document.querySelectorAll<HTMLElement>('.scan-results li')];
    // skipped pages are not listed
    expect(rows).toHaveLength(2);
    expect(
      within(rows[0])
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual([coreT('Open note')]);
    expect(within(rows[1]).queryAllByRole('button')).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: coreT('Assign unmatched scans') }));
    expect(currentDialog()).toBeNull();
    expect(openUnmatched).toHaveBeenCalledTimes(1);
  });

  it('Open note goes to the scan entry line and offers the results again', async () => {
    renderLayer();
    const openFile = vi.spyOn(ctx, 'openFile');
    const result = filed();
    const feature = makeFeature();
    act(() => feature.report([result], true));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: coreT('Open note') }));
    });
    await waitFor(() => expect(openFile).toHaveBeenCalledWith(NOTE, { line: 7 }));
    expect(currentDialog()).toBeNull();
    const again = currentToasts().find((x) => x.action?.label === coreT('Show results'))!;
    expect(again).toBeTruthy();
    act(() => again.action!.run());
    expect(currentDialog()?.spec.kind).toBe('scanResults');
    // the same results, Undo still there
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: coreT('Undo') }));
    });
    expect(pipeline.undo).toHaveBeenCalledWith(result);
  });

  it('Open note without the entry in the note opens it at the top', async () => {
    renderLayer();
    const openFile = vi.spyOn(ctx, 'openFile');
    const feature = makeFeature();
    act(() => feature.report([filed({ hash: '9999' })], true));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: coreT('Open note') }));
    });
    await waitFor(() => expect(openFile).toHaveBeenCalledWith(NOTE, undefined));
  });
});

describe('runs and reports', () => {
  it('a background run posts a Details toast that opens the results', async () => {
    renderLayer();
    const feature = makeFeature();
    act(() => feature.report([filed()], false));
    expect(currentDialog()).toBeNull();
    const toast = currentToasts().at(-1)!;
    expect(toast.message.startsWith(coreT('Scans') + ': ')).toBe(true);
    expect(toast.message).toContain(summarizeResults(coreT, [filed()]));
    expect(toast.action?.label).toBe(coreT('Details'));
    act(() => toast.action!.run());
    expect(currentDialog()?.spec.kind).toBe('scanResults');
  });

  it('a manual run with only skipped pages says no worksheet pages were found', () => {
    renderLayer();
    const notify = vi.fn();
    const feature = makeFeature({ notify });
    act(() => feature.report([{ source: 'a.jpg', status: 'skipped' }], true));
    expect(notify).toHaveBeenCalledWith('info', coreT('No worksheet pages were found.'));
    expect(currentDialog()).toBeNull();
    // a background run with nothing to show stays quiet, and so does an empty manual run
    notify.mockClear();
    act(() => feature.report([{ source: 'a.jpg', status: 'skipped' }], false));
    act(() => feature.report([], true));
    expect(notify).not.toHaveBeenCalled();
  });

  it('a background folder or Slack run opens no dialog and leaves focus in the editor', async () => {
    renderLayer();
    const editor = document.createElement('textarea');
    document.body.append(editor);
    editor.focus();
    const status = { update: vi.fn(), close: vi.fn() };
    const notifyStatus = vi.fn(() => status);
    const dialogsDuring: unknown[] = [];
    pipeline.run.mockImplementation(
      async (_inputs: readonly ScanInput[], opts?: { onProgress?: (n: number, l: string) => void }) => {
        opts?.onProgress?.(1, 'a.jpg');
        dialogsDuring.push(currentDialog());
        return [filed()];
      },
    );
    const feature = makeFeature({ notifyStatus });
    const inputs: ScanInput[] = [{ name: 'a.jpg', bytes: new ArrayBuffer(2) }];

    const results = await inAct(() => feature.runWithProgress(inputs, false, false));
    act(() => feature.report(results, false));
    expect(withProgressSpy).not.toHaveBeenCalled();
    expect(dialogsDuring).toEqual([null]);
    expect(currentDialog()).toBeNull();
    expect(notifyStatus).toHaveBeenCalledWith(coreT('Processing scans…'));
    expect(status.update).toHaveBeenCalledWith(coreT('Processing scans… {0} page(s) done ({1})', '1', 'a.jpg'));
    expect(status.close).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(editor);

    // a shared folder (skipNoQr) shows nothing at all
    await inAct(() => feature.runWithProgress(inputs, true, false));
    expect(notifyStatus).toHaveBeenCalledTimes(1);
    expect(withProgressSpy).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(editor);
    editor.remove();
  });

  it('the status toast closes when the run throws', async () => {
    const status = { update: vi.fn(), close: vi.fn() };
    pipeline.run.mockRejectedValueOnce(new Error('boom'));
    const feature = makeFeature({ notifyStatus: vi.fn(() => status) });
    await expect(feature.runWithProgress([{ name: 'a.jpg', bytes: new ArrayBuffer(1) }], false, false)).rejects.toThrow('boom');
    expect(status.close).toHaveBeenCalledTimes(1);
    // the next batch is not blocked
    pipeline.run.mockResolvedValueOnce([]);
    await expect(feature.runWithProgress([], false, false)).resolves.toEqual([]);
  });

  it('a manual run shows the progress dialog', async () => {
    const notifyStatus = vi.fn();
    pipeline.run.mockImplementation(
      async (
        _inputs: readonly ScanInput[],
        opts?: {
          skipNoQr?: boolean;
          onProgress?: (n: number, l: string) => void;
        },
      ) => {
        opts?.onProgress?.(2, 'b.pdf p.1');
        return [];
      },
    );
    const feature = makeFeature({ notifyStatus });
    await feature.runWithProgress([{ name: 'b.pdf', bytes: new ArrayBuffer(1) }], false, true);
    expect(withProgressSpy).toHaveBeenCalledWith(coreT('Processing scans…'), expect.any(Function));
    expect(progressLines).toEqual([coreT('Processing scans… {0} page(s) done ({1})', '2', 'b.pdf p.1')]);
    expect(notifyStatus).not.toHaveBeenCalled();
    expect(pipeline.run.mock.calls[0][1]).toMatchObject({ skipNoQr: false });
  });

  it('a second batch while one runs waits for it', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let first = true;
    pipeline.run.mockImplementation(async () => {
      if (first) {
        first = false;
        await gate;
      }
      return [];
    });
    const feature = makeFeature({
      notifyStatus: vi.fn(() => ({ update: vi.fn(), close: vi.fn() })),
    });
    const one = feature.runWithProgress([{ name: 'a.jpg', bytes: new ArrayBuffer(1) }], false, false);
    const two = feature.runWithProgress([{ name: 'b.jpg', bytes: new ArrayBuffer(1) }], true, false);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(pipeline.run).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([one, two]);
    expect(pipeline.run).toHaveBeenCalledTimes(2);
    expect((pipeline.run.mock.calls[1][0] as ScanInput[])[0].name).toBe('b.jpg');
  });

  it('scanFeature() is the one set for the vault', () => {
    expect(scanFeature()).toBeUndefined();
    const feature = makeFeature();
    setScanFeature(feature);
    expect(scanFeature()).toBe(feature);
  });
});

describe('result texts', () => {
  const t = createTranslator();

  it('summarizeResults and describeResult match the plugin texts', () => {
    expect(
      summarizeResults(t, [
        filed(),
        filed(),
        { source: 'b', status: 'duplicate' },
        { source: 'c', status: 'unmatched' },
        { source: 'd', status: 'blank' },
        { source: 'e', status: 'unsupported' },
        { source: 'f', status: 'error' },
        { source: 'g', status: 'skipped' },
      ]),
    ).toBe('7 page(s): 2 filed, 1 already filed, 1 unmatched, 1 blank, 1 unsupported, 1 failed');
    expect(summarizeResults(t, [{ source: 'g', status: 'skipped' }])).toBe('0 page(s): nothing to do');

    expect(describeResult(t, filed())).toBe(`Filed in ${NOTE} › [UHW010 PCR] amp`);
    expect(describeResult(t, filed({ block: undefined }))).toBe(`Filed in ${NOTE}`);
    expect(describeResult(t, filed({ legacy: true }))).toBe(
      `Filed in ${NOTE} › [UHW010 PCR] amp This printout is from before 0.123.0 and does not say which block it is, so check that it went to the right one.`,
    );
    expect(describeResult(t, filed({ matchedBy: 'opId' }))).toBe(
      `Filed in ${NOTE} › [UHW010 PCR] amp The block is no longer where it was printed from, so check that the scan went to the right one.`,
    );
    expect(describeResult(t, filed({ replacedMissing: true }))).toBe(
      `Filed in ${NOTE} › [UHW010 PCR] amp The note already had this scan, but its image was deleted, so it was filed again in its place.`,
    );
    expect(describeResult(t, { source: 'a', status: 'duplicate', notePath: NOTE })).toBe(`Already in ${NOTE}; skipped`);
    expect(describeResult(t, { source: 'a', status: 'blank' })).toBe('Blank page; skipped');
    expect(describeResult(t, { source: 'a', status: 'skipped' })).toBe('No worksheet QR code; left alone');
    expect(
      describeResult(t, {
        source: 'a',
        status: 'skipped',
        reason: 'cancelled',
      }),
    ).toBe('Cancelled; the scan is still waiting to be assigned.');
    expect(describeResult(t, { source: 'a', status: 'error', message: 'boom' })).toBe('Failed: boom');
    expect(
      describeResult(t, {
        source: 'a',
        status: 'unsupported',
        reason: 'zip-limit',
      }),
    ).toBe('Zip too large: only the first files were read (at most 200 files, 500 MB).');
    expect(
      describeResult(t, {
        source: 'a',
        status: 'unsupported',
        reason: 'pdf-limit',
      }),
    ).toBe('PDF too long: only the first 50 pages were read.');
    expect(
      describeResult(t, {
        source: 'a',
        status: 'unsupported',
        reason: 'unknown',
      }),
    ).toBe('Not an image, PDF or zip file.');
    expect(
      describeResult(t, {
        source: 'a',
        status: 'unmatched',
        reason: 'note-not-found',
        payload: PAYLOAD,
      }),
    ).toBe(`No note has the ID ${ID}. Assign it with "Assign unmatched scans".`);
    expect(describeResult(t, { source: 'a', status: 'unmatched' })).toBe(
      'No worksheet QR code was found. Assign it with "Assign unmatched scans".',
    );

    expect(unmatchedReasonText(t, 'duplicate-id', ID)).toBe(`Several notes share the ID ${ID}.`);
    expect(unmatchedReasonText(t, 'note-only')).toBe('The QR code names the note but no unit operation.');
    expect(unmatchedReasonText(t, 'no-unit-op')).toBe('The unit operation it was printed from is no longer in the note.');
    expect(unmatchedReasonText(t, 'ambiguous')).toBe('The note has several unit operations it could belong to.');
    expect(unmatchedReasonText(t, 'renamed')).toBe(
      'The unit operation it was printed from was deleted, or its title or alias changed since, so it is unclear which block it belongs to.',
    );
    expect(unmatchedReasonText(t, 'whatever')).toBe('');
  });

  it('HEIC, TIFF and note-busy texts are the app texts and never name Obsidian', () => {
    for (const lang of ['ko', 'en'] as const) {
      setLang(lang);
      const heic = describeResult(coreT, {
        source: 'a',
        status: 'unsupported',
        reason: 'heic',
      });
      const tiff = describeResult(coreT, {
        source: 'a',
        status: 'unsupported',
        reason: 'tiff',
      });
      const busy = unmatchedReasonText(coreT, 'note-busy');
      expect(heic).toBe(overrideOr('scan.heicAdvice'));
      expect(tiff).toBe(overrideOr('scan.tiffAdvice'));
      expect(busy).toBe(appT('scan.noteBusy'));
      for (const text of [heic, tiff, busy]) {
        expect(text).not.toMatch(/Obsidian|Labnote Assistant|docs\/SCAN\.md/);
        expect(text).not.toBe('');
      }
    }
  });
});
