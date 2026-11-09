// @vitest-environment jsdom
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { setLang } from '../../../i18n/lang';
import { createTestHost, type TestHost } from '../../__tests__/testHost';
import { NoteIdIndex, setNoteIdIndex, type NoteRef } from '../../barcode/noteIdIndex';
import { cleanupDialogs, renderLayer, styleAttributes } from '../../host/__tests__/harness';
import { currentDialog } from '../../host/dialogStore';
import { clearToasts } from '../../host/toastStore';
import { coreT } from '../../i18n';
import { UNMATCHED_FOLDER } from '../../port/imageStore';
import type { PageDecoder, ScanPipeline, ScanResult } from '../../port/scanPipeline';
import { unmatchedReasonText } from '../../port/scanResults';
import { assignUnmatched, isDateInput, listUnmatched, parsePageInput, type AssignDeps } from '../../port/unmatchedScans';
import { ScanFeature } from '../scanFeature';

const ID = 'LN-7K3M9QX2';
const NOTE = 'labnote/001_exp/001_pcr.labnote.md';
const OTHER = 'labnote/001_exp/002_gel.labnote.md';
const NOTE_TEXT = ['---', `labnote_id: ${ID}`, '---', '### [UHW010 PCR] amp', '', '### [UHW020 Gel] run', ''].join('\n');
/** UHW020 moved up to index 1; index 2 now holds another unit operation. */
const MOVED_TEXT = ['---', `labnote_id: ${ID}`, '---', '### [UHW020 Gel] run', '', '### [UHW030 Blot] dry', ''].join('\n');
/** A queued page whose QR code named the note, unit operation 2 (UHW020), page 1/1, printed 2026-10-15. */
const QUEUED = `20261016-093012_${ID}_q2-UHW020-1o1-261015_renamed_IMG_1.jpg`;
const QUEUED_PATH = `${UNMATCHED_FOLDER}/${QUEUED}`;
const PLAIN = '20261016-093013_unknown_no-qr_IMG_2.jpg';
const PLAIN_PATH = `${UNMATCHED_FOLDER}/${PLAIN}`;

const ref = (path: string): NoteRef => ({ path, basename: path.slice(path.lastIndexOf('/') + 1, -'.md'.length), ctime: 0 });

describe('parsePageInput and isDateInput', () => {
  it('reads "2/3" and "2", and refuses the rest', () => {
    expect(parsePageInput('2/3')).toEqual({ page: 2, pageCount: 3 });
    expect(parsePageInput(' 2 / 3 ')).toEqual({ page: 2, pageCount: 3 });
    expect(parsePageInput('2')).toEqual({ page: 2, pageCount: 2 });
    expect(parsePageInput('0')).toBeUndefined();
    expect(parsePageInput('3/2')).toBeUndefined();
    expect(parsePageInput('a/b')).toBeUndefined();
    expect(parsePageInput('')).toBeUndefined();
  });

  it('takes real YYYY-MM-DD dates only', () => {
    expect(isDateInput('2026-10-15')).toBe(true);
    expect(isDateInput(' 2024-02-29 ')).toBe(true);
    expect(isDateInput('2026-02-30')).toBe(false);
    expect(isDateInput('2026-1-5')).toBe(false);
    expect(isDateInput('')).toBe(false);
  });
});

describe('listUnmatched', () => {
  it('lists the images directly in the queue folder, by name', () => {
    expect(
      listUnmatched([
        `${UNMATCHED_FOLDER}/b.jpg`,
        `${UNMATCHED_FOLDER}/a.PNG`,
        `${UNMATCHED_FOLDER}/sub/c.jpg`,
        `${UNMATCHED_FOLDER}/d.gif`,
        'images/scans/e.jpg',
      ]),
    ).toEqual([
      { path: `${UNMATCHED_FOLDER}/a.PNG`, name: 'a.PNG' },
      { path: `${UNMATCHED_FOLDER}/b.jpg`, name: 'b.jpg' },
    ]);
  });
});

describe('assignUnmatched', () => {
  let h: TestHost;
  let fileManually: ReturnType<typeof vi.fn>;

  function deps(files: Record<string, string>): AssignDeps {
    h = createTestHost(files);
    fileManually = vi.fn(async (): Promise<ScanResult> => ({ source: 'IMG_1.jpg', status: 'filed', notePath: NOTE }));
    return {
      host: h.host,
      pipeline: { fileManually } as unknown as Pick<ScanPipeline, 'fileManually'>,
      noteIds: { filesWithId: (id: string) => (id === ID ? [ref(NOTE)] : []) },
      notes: async () => Object.keys(files).filter((p) => p.endsWith('.md')).map(ref),
      read: (p) => h.host.fs.read(p),
    };
  }

  afterEach(() => h.cleanup());

  it('the QR note is listed first, and its unit op first only when the same opId is still at that index', async () => {
    const d = deps({ [OTHER]: '', [NOTE]: NOTE_TEXT, 'notes/free.md': '' });
    h.answer.pick((items: Array<{ value: unknown }>) => items[0].value, undefined);
    expect(await assignUnmatched(d, { path: QUEUED_PATH, name: QUEUED })).toBeUndefined();
    const [notes, ops] = h.asked.pick;
    // workflow notes only, the note the QR code named first and marked
    expect(notes.items.map((i) => (i.value as NoteRef).path)).toEqual([NOTE, OTHER]);
    expect(notes.items[0]).toMatchObject({ label: '001_pcr', description: coreT('from the QR code'), detail: 'labnote/001_exp' });
    expect(notes.items[1].description).toBeUndefined();
    expect(notes.opts?.title).toBe(coreT('Assign to which note?'));
    // UHW020 is still unit operation 2: offered first, with the QR hint
    expect(ops.items.map((i) => i.value)).toEqual([2, 1, 0]);
    expect(ops.items[0]).toMatchObject({ label: '2. [UHW020 Gel] run', description: coreT('QR code: unit operation {0}', '2') });
    expect(ops.opts?.title).toBe(coreT('Assign to which unit operation?'));
    expect(fileManually).not.toHaveBeenCalled();
  });

  it('a unit op that moved keeps the natural order and the title says what the QR code named', async () => {
    const d = deps({ [NOTE]: MOVED_TEXT });
    h.answer.pick((items: Array<{ value: unknown }>) => items[0].value, undefined);
    await assignUnmatched(d, { path: QUEUED_PATH, name: QUEUED });
    const ops = h.asked.pick[1];
    expect(ops.items.map((i) => i.value)).toEqual([1, 2, 0]);
    expect(ops.items.every((i) => i.description === undefined)).toBe(true);
    expect(ops.opts?.title).toBe(
      `${coreT('Assign to which unit operation?')} ${coreT('The QR code says unit operation {0} ({1}).', '2', 'UHW020')}`,
    );
  });

  it('files the page with the note, unit op, page and date the user gave, and says what became of it', async () => {
    const d = deps({ [NOTE]: NOTE_TEXT });
    h.answer.pick((items: Array<{ value: unknown }>) => items[0].value, () => 2);
    h.answer.prompt('2/3', ' 2026-10-14 ');
    const r = await assignUnmatched(d, { path: QUEUED_PATH, name: QUEUED });
    expect(r?.status).toBe('filed');
    // the QR code's page and date are the defaults
    expect(h.asked.prompt.map((p) => p.value)).toEqual(['1/1', '2026-10-15']);
    expect(h.asked.prompt[0].validate?.('x')).toBe(coreT('Enter a page like 2/3.'));
    expect(h.asked.prompt[1].validate?.('')).toBeNull();
    expect(h.asked.prompt[1].validate?.('2026-02-30')).toBe(coreT('Enter a date like 2026-10-15, or leave it empty.'));
    expect(fileManually).toHaveBeenCalledWith(
      { path: QUEUED_PATH, name: QUEUED },
      { note: ref(NOTE), unitOpIndex: 2, page: { page: 2, pageCount: 3 }, printedOn: '2026-10-14' },
    );
    expect(h.notes.map((n) => n.kind)).toEqual(['info']);
  });

  it('an empty print date files without one; a page without a QR code starts at 1/1 and no hint', async () => {
    const d = deps({ [NOTE]: NOTE_TEXT });
    h.answer.pick((items: Array<{ value: unknown }>) => items[0].value, () => 0);
    h.answer.prompt('1/1', '');
    await assignUnmatched(d, { path: PLAIN_PATH, name: PLAIN });
    expect(h.asked.pick[0].items[0].description).toBeUndefined();
    expect(h.asked.prompt.map((p) => p.value)).toEqual(['1/1', '']);
    expect(fileManually).toHaveBeenCalledWith(
      { path: PLAIN_PATH, name: PLAIN },
      { note: ref(NOTE), unitOpIndex: 0, page: { page: 1, pageCount: 1 } },
    );
  });
});

describe('unmatched dialog', () => {
  let h: TestHost;
  let images: Map<string, ArrayBuffer>;
  let created: number;
  let fileManually: ReturnType<typeof vi.fn>;
  const createObjectURL = vi.fn();
  const revokeObjectURL = vi.fn();

  function makeFeature(): ScanFeature {
    fileManually = vi.fn(async (): Promise<ScanResult> => ({ source: 'IMG_1.jpg', status: 'filed', notePath: NOTE }));
    return new ScanFeature(h.ctx, {
      pipeline: { fileManually } as unknown as ScanPipeline,
      decoder: { expand: vi.fn() } as unknown as PageDecoder,
      images: {
        list: async () => [...images.keys()],
        read: async (p) => images.get(p)!,
      },
    });
  }

  beforeEach(() => {
    setLang('en');
    const files = { [NOTE]: NOTE_TEXT };
    h = createTestHost(files);
    setNoteIdIndex(
      new NoteIdIndex({
        files: async () => Object.keys(files),
        read: (p) => h.host.fs.read(p),
        ctimes: async (ps) => ps.map(() => 0),
      }),
    );
    images = new Map([
      [PLAIN_PATH, new Uint8Array([1]).buffer],
      [QUEUED_PATH, new Uint8Array([2]).buffer],
      ['images/scans/filed.jpg', new Uint8Array([3]).buffer],
    ]);
    created = 0;
    createObjectURL.mockReset().mockImplementation(() => `blob:${++created}`);
    revokeObjectURL.mockReset();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
  });

  afterEach(() => {
    cleanupDialogs();
    act(() => clearToasts());
    setNoteIdIndex(undefined);
    h.cleanup();
    act(() => setLang('ko'));
  });

  /** Open the queue and let the list and thumbnails load. The command's promise is wrapped: an async function would wait for it. */
  async function open(feature: ScanFeature): Promise<{ done: Promise<void> }> {
    let done!: Promise<void>;
    await act(async () => {
      done = feature.openUnmatched();
    });
    return { done };
  }

  it('lists the queue with the reason, and an empty queue says so', async () => {
    renderLayer();
    const feature = makeFeature();
    const { done } = await open(feature);
    const dialog = screen.getByRole('dialog', { name: coreT('Assign unmatched scans') });
    const rows = dialog.querySelectorAll('.scan-unmatched li');
    expect([...rows].map((r) => r.querySelector('.scan-result-name')!.textContent)).toEqual([QUEUED, PLAIN]);
    expect(rows[0].textContent).toContain(unmatchedReasonText(coreT, 'renamed', ID));
    expect(within(rows[0] as HTMLElement).getAllByRole('button').map((b) => b.textContent)).toEqual(['', coreT('Assign'), coreT('Delete')]);
    expect(styleAttributes()).toEqual([]);
    cleanupDialogs();
    await act(async () => {
      await done;
    });

    images.clear();
    const { done: again } = await open(feature);
    expect(screen.getByRole('dialog').textContent).toContain(coreT('No unmatched scans.'));
    cleanupDialogs();
    await act(async () => {
      await again;
    });
  });

  it('thumbnails are blob URLs and are revoked on close', async () => {
    renderLayer();
    const { done } = await open(makeFeature());
    const thumbs = [...document.querySelectorAll<HTMLImageElement>('img.scan-thumb')];
    expect(thumbs.map((i) => i.getAttribute('src'))).toEqual(['blob:1', 'blob:2']);
    expect(thumbs.map((i) => i.alt)).toEqual([QUEUED, PLAIN]);
    expect((createObjectURL.mock.calls[0][0] as Blob).type).toBe('image/jpeg');
    // a click zooms inside the dialog, never window.open
    const winOpen = vi.spyOn(window, 'open').mockImplementation(() => null);
    fireEvent.click(thumbs[1].closest('button')!);
    const zoom = document.querySelector<HTMLButtonElement>('.scan-zoom')!;
    expect(zoom.querySelector('img')!.getAttribute('src')).toBe('blob:2');
    expect(document.activeElement).toBe(zoom);
    expect(winOpen).not.toHaveBeenCalled();
    // Escape leaves the zoom, not the dialog
    fireEvent.keyDown(zoom, { key: 'Escape' });
    expect(document.querySelector('.scan-zoom')).toBeNull();
    expect(currentDialog()?.spec.kind).toBe('scanUnmatched');
    expect(revokeObjectURL).not.toHaveBeenCalled();
    cleanupDialogs();
    await act(async () => {
      await done;
    });
    expect(revokeObjectURL.mock.calls.map((c) => c[0]).sort()).toEqual(['blob:1', 'blob:2']);
    winOpen.mockRestore();
  });

  it('Delete moves the queue image to the Recycle Bin', async () => {
    renderLayer();
    const trash = vi.spyOn(h.host.fs, 'trash').mockResolvedValue(undefined);
    const { done } = await open(makeFeature());
    const row = [...document.querySelectorAll<HTMLElement>('.scan-unmatched li')].find((r) => r.textContent!.includes(PLAIN))!;
    await act(async () => {
      fireEvent.click(within(row).getByRole('button', { name: coreT('Delete') }));
    });
    expect(trash).toHaveBeenCalledWith(PLAIN_PATH);
    expect([...document.querySelectorAll('.scan-unmatched li .scan-result-name')].map((n) => n.textContent)).toEqual([QUEUED]);
    // the deleted row's thumbnail URL is given back at once
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:2');
    cleanupDialogs();
    await act(async () => {
      await done;
    });
  });

  it('Assign closes the queue, asks note, unit op, page and date, files it and shows the queue again', async () => {
    renderLayer();
    h.answer.pick((items: Array<{ value: unknown }>) => items[0].value, (items: Array<{ value: unknown }>) => items[0].value);
    h.answer.prompt('1/1', '2026-10-15');
    const { done } = await open(makeFeature());
    const row = [...document.querySelectorAll<HTMLElement>('.scan-unmatched li')].find((r) => r.textContent!.includes(QUEUED))!;
    await act(async () => {
      fireEvent.click(within(row).getByRole('button', { name: coreT('Assign') }));
    });
    await waitFor(() => expect(currentDialog()?.spec.kind).toBe('scanUnmatched'));
    expect(fileManually).toHaveBeenCalledWith(
      { path: QUEUED_PATH, name: QUEUED },
      { note: expect.objectContaining({ path: NOTE }), unitOpIndex: 2, page: { page: 1, pageCount: 1 }, printedOn: '2026-10-15' },
    );
    expect(h.notes).toHaveLength(1);
    // the queue is shown again (the plugin re-renders its modal)
    expect(currentDialog()?.spec.kind).toBe('scanUnmatched');
    cleanupDialogs();
    await act(async () => {
      await done;
    });
    expect(currentDialog()).toBeNull();
  });
});
