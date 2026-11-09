import { afterEach, describe, expect, it, vi } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { createTranslator, listFiledScans, type LabnoteHost } from '@labnoteo/core';
import { getSeoulDateString } from '@labnoteo/core/lib/dateUtils';
import { readNoteId } from '@labnoteo/core/lib/noteId';
import { decodeScanPayload, unitOpFingerprint, type PagePayload, type ScanPayload } from '@labnoteo/core/lib/scanPayload';
import type { AppFs } from '../../../fs/tauriLabnoteFs';
import { frontMatterText } from '../../frontMatterText';
import { NoteBusyError } from '../../noteErrors';
import { NoteIdService, type NoteIdSource } from '../../port/noteIdService';
import {
  ScanPipeline,
  ZIP_LIMITS,
  embedLinkPath,
  safeSourceName,
  unzipScans,
  type DecodedPage,
  type PageDecoder,
  type ScanInput,
  type ScanResult,
} from '../../port/scanPipeline';
import { noteStamp } from '../pipelineDeps';

const ID = 'LN-7K3M9QX2';
const NOTE = 'e/01_x.labnote.md';
const NOTE_TEXT = `---\nlabnote_id: ${ID}\n---\n### [UHW010 PCR] amp\n#### Worksheet scans\n### [UHW020 Gel] run\n`;

/** 메모리 위 보관함: 노트 글, 이미지 바이트, 그리고 파이프라인이 쓰는 의존성(가짜 processNote 포함). */
function memVault(notes: Record<string, string>) {
  const text = new Map(Object.entries(notes));
  const images = new Map<string, Uint8Array>();
  const exists = (p: string) => text.has(p) || images.has(p);
  const fs = {
    read: vi.fn(async (p: string) => {
      const s = text.get(p);
      if (s === undefined) throw Object.assign(new Error(`missing ${p}`), { code: 'ENOENT' });
      return s;
    }),
    trash: vi.fn(async (p: string) => {
      images.delete(p);
      text.delete(p);
    }),
  } as unknown as AppFs & { read: ReturnType<typeof vi.fn>; trash: ReturnType<typeof vi.fn> };
  /** 다음 processNote 호출들이 NoteBusyError 로 거절할 횟수(Infinity 면 늘). */
  let busy = 0;
  const processNote = vi.fn(async (path: string, fn: (t: string) => string) => {
    if (busy > 0) {
      busy--;
      throw new NoteBusyError(path);
    }
    const before = text.get(path)!;
    const next = fn(before);
    text.set(path, next);
    return next !== before;
  });
  const source: NoteIdSource = {
    files: () => [...text.keys()].filter((p) => p.endsWith('.md')).map((p) => ({ path: p, basename: p.slice(p.lastIndexOf('/') + 1, -3), ctime: 1 })),
    idOf: (p) => readNoteId(frontMatterText(text.get(p) ?? '')),
    read: async (p) => text.get(p) ?? '',
    process: async (p, fn) => void text.set(p, fn(text.get(p) ?? '')),
    exists: (p) => text.has(p),
  };
  const confirm = vi.fn(async () => false);
  const host = { notify: vi.fn(), t: createTranslator(), confirm, pick: vi.fn(async () => undefined) } as unknown as LabnoteHost;
  const imageDeps = {
    exists: vi.fn(async (p: string) => exists(p)),
    readBinary: vi.fn(async (p: string) => {
      const b = images.get(p);
      if (!b) throw { kind: 'notFound', message: p };
      return b.slice().buffer;
    }),
    writeScanImage: vi.fn(async (dir: string, name: string, bytes: Uint8Array) => {
      const p = `${dir}/${name}`;
      if (exists(p)) throw { kind: 'exists', message: p };
      images.set(p, bytes.slice());
      return p;
    }),
    // 이름만 쓴 임베드도 그 이미지를 가리킨다(보관함에서 이름이 하나뿐일 때).
    backlinks: vi.fn((p: string) =>
      [...text.entries()]
        .filter(([, body]) => body.includes(`[[${p}`) || body.includes(`[[${p.slice(p.lastIndexOf('/') + 1)}`))
        .map(([source]) => ({ source })),
    ),
  };
  return {
    text,
    images,
    fs,
    processNote,
    host,
    confirm,
    imageDeps,
    noteIds: new NoteIdService(source, host),
    setBusy: (n: number) => void (busy = n),
    imagesUnder: (prefix: string) => [...images.keys()].filter((p) => p.startsWith(prefix)),
  };
}

const bytesOf = (...b: number[]) => new Uint8Array(b).buffer;

/** 입력 이름마다 그 입력이 풀리는 페이지들. */
function decoderFor(pages: Record<string, DecodedPage[] | Error>): PageDecoder {
  return {
    async expand(input, onPage) {
      const out = pages[input.name];
      if (out instanceof Error) throw out;
      for (const p of out ?? []) await onPage({ ...p, source: input.name });
      return [];
    },
  };
}

const page = (p: ScanPayload | undefined, hash: string, extra: Partial<DecodedPage> = {}): DecodedPage => ({
  source: 'IMG.jpg',
  hash,
  blank: false,
  payload: p,
  render: async () => bytesOf(1, 2, 3),
  ...extra,
});

const qr = (text: string) => decodeScanPayload(text)!;
const input = (name: string): ScanInput => ({ name, bytes: new ArrayBuffer(0) });

function setup(
  notes: Record<string, string>,
  pages: Record<string, DecodedPage[] | Error>,
  opts: { embedWidth?: number; autoUpdateLastUpdated?: boolean } = {},
) {
  const v = memVault(notes);
  const pipeline = new ScanPipeline({
    host: v.host,
    t: createTranslator(),
    noteIds: v.noteIds,
    fs: v.fs,
    processNote: v.processNote,
    images: v.imageDeps,
    listImages: async () => [...v.images.keys()],
    decoder: decoderFor(pages),
    embedWidth: () => opts.embedWidth ?? 200,
    stampNote: noteStamp({ autoUpdateLastUpdated: !!opts.autoUpdateLastUpdated }),
  });
  return { ...v, pipeline };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('ScanPipeline.run (vendor scanPipeline.test.ts)', () => {
  const pagePayload = (over: Partial<PagePayload> = {}): PagePayload => ({
    noteId: ID,
    unitOpIndex: 2,
    opId: 'UHW020',
    page: 1,
    pageCount: 2,
    printedOn: '2026-10-15',
    ...over,
  });

  it('files pages into their unit operation, writing the note once', async () => {
    const s = setup(
      { [NOTE]: NOTE_TEXT },
      {
        'a.jpg': [page(pagePayload({ page: 2 }), 'bbbbbbbbbbbb')],
        'b.jpg': [page(pagePayload({ page: 1 }), 'aaaaaaaaaaaa')],
      },
      { embedWidth: 0 },
    );
    const results = await s.pipeline.run([input('a.jpg'), input('b.jpg')]);
    expect(results.map((r) => [r.input, r.status])).toEqual([
      ['a.jpg', 'filed'],
      ['b.jpg', 'filed'],
    ]);
    expect(results[0].imagePath).toMatch(new RegExp(`^e/images/scans/${ID}_u2_p2_\\d{8}\\.jpg$`));
    expect(s.images.has(results[0].imagePath!)).toBe(true);
    expect(s.processNote).toHaveBeenCalledTimes(1);
    const filed = listFiledScans(s.text.get(NOTE)!);
    expect(filed.map((f) => [f.unitOpIndex, f.page, f.hash])).toEqual([
      [2, 1, 'aaaaaaaaaaaa'],
      [2, 2, 'bbbbbbbbbbbb'],
    ]);
    // 보관함에서 이름이 하나뿐이면 이름만(편집기의 embedText 규칙).
    const name = results[1].imagePath!.slice(results[1].imagePath!.lastIndexOf('/') + 1);
    expect(filed[0].embed).toBe(`![[${name}]]`);
  });

  it('files pages as thumbnails with a full-size link when a width is set', async () => {
    const s = setup({ [NOTE]: NOTE_TEXT }, { 'a.jpg': [page(pagePayload({ page: 1 }), 'aaaaaaaaaaaa')] }, { embedWidth: 300 });
    const [r] = await s.pipeline.run([input('a.jpg')]);
    expect(r.status).toBe('filed');
    const name = r.imagePath!.slice(r.imagePath!.lastIndexOf('/') + 1);
    const text = s.text.get(NOTE)!;
    expect(listFiledScans(text)[0].embed).toBe(`![[${name}|300]]`);
    expect(text).toContain(` · [[${name}|Open full size]]*`);
  });

  it('uses the vault path in the embed when the name is not unique in the vault', async () => {
    const s = setup({ [NOTE]: NOTE_TEXT }, { 'a.jpg': [page(pagePayload({ page: 1 }), 'aaaaaaaaaaaa')] }, { embedWidth: 0 });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-15T03:00:00Z'));
    s.images.set(`other/${ID}_u2_p1_20261015.jpg`, new Uint8Array([7]));
    const [r] = await s.pipeline.run([input('a.jpg')]);
    expect(listFiledScans(s.text.get(NOTE)!)[0].embed).toBe(`![[${r.imagePath}]]`);
  });

  it('counts blank, unreadable and unknown pages without touching any note', async () => {
    const s = setup(
      { [NOTE]: NOTE_TEXT },
      {
        'blank.jpg': [page(undefined, '111111111111', { blank: true })],
        'noqr.jpg': [page(undefined, '222222222222')],
        'other.jpg': [page(pagePayload({ noteId: 'LN-ZZZZZZZZ' }), '333333333333')],
        'noteonly.jpg': [page({ noteId: ID }, '444444444444')],
        'gone.jpg': [page(pagePayload({ unitOpIndex: 5, opId: 'UHW999' }), '555555555555')],
        'broken.pdf': new Error('bad pdf'),
      },
    );
    const before = s.text.get(NOTE);
    const results = await s.pipeline.run(['blank.jpg', 'noqr.jpg', 'other.jpg', 'noteonly.jpg', 'gone.jpg', 'broken.pdf'].map(input));
    expect(results.map((r) => [r.input, r.status, r.reason ?? r.message])).toEqual([
      ['blank.jpg', 'blank', undefined],
      ['noqr.jpg', 'unmatched', 'no-qr'],
      ['other.jpg', 'unmatched', 'note-not-found'],
      ['noteonly.jpg', 'unmatched', 'note-only'],
      ['gone.jpg', 'unmatched', 'no-unit-op'],
      ['broken.pdf', 'error', 'bad pdf'],
    ]);
    for (const r of results.filter((r) => r.status === 'unmatched')) {
      expect(r.unmatchedPath).toMatch(/^_labnote-scans\/unmatched\//);
      expect(s.images.has(r.unmatchedPath!)).toBe(true);
    }
    expect(results.find((r) => r.input === 'other.jpg')!.unmatchedPath).toContain('_LN-ZZZZZZZZ_');
    expect(results.find((r) => r.input === 'gone.jpg')!.unmatchedPath).toContain(
      `_${ID}_q5-UHW999-1o2-261015_no-unit-op_h555555555555-jpg_gone.jpg`,
    );
    expect(s.processNote).not.toHaveBeenCalled();
    expect(s.text.get(NOTE)).toBe(before);
  });

  it('passes over pages without a QR in a shared folder', async () => {
    const s = setup({ [NOTE]: NOTE_TEXT }, { 'cat.jpg': [page(undefined, '222222222222')] });
    const results = await s.pipeline.run([input('cat.jpg')], { skipNoQr: true });
    expect(results.map((r) => [r.status, r.reason])).toEqual([['skipped', 'no-qr']]);
    expect(s.images.size).toBe(0);
  });

  it('skips the same photo arriving twice, in one batch or in a later one', async () => {
    const same = page(pagePayload(), 'aaaaaaaaaaaa');
    const s = setup({ [NOTE]: NOTE_TEXT }, { 'a.jpg': [same], 'a-copy.jpg': [same] });
    const first = await s.pipeline.run([input('a.jpg'), input('a-copy.jpg')]);
    expect(first.map((r) => r.status)).toEqual(['filed', 'duplicate']);
    const again = await s.pipeline.run([input('a-copy.jpg')]);
    expect(again.map((r) => r.status)).toEqual(['duplicate']);
    expect(listFiledScans(s.text.get(NOTE)!)).toHaveLength(1);
  });

  it('keeps an earlier scan of the same page and lists it as previous', async () => {
    const s = setup(
      { [NOTE]: NOTE_TEXT },
      { 'old.jpg': [page(pagePayload(), 'aaaaaaaaaaaa')], 'new.jpg': [page(pagePayload(), 'bbbbbbbbbbbb')] },
      { embedWidth: 0 },
    );
    const [old] = await s.pipeline.run([input('old.jpg')]);
    const [next] = await s.pipeline.run([input('new.jpg')]);
    const oldName = old.imagePath!.slice(old.imagePath!.lastIndexOf('/') + 1);
    expect(next.previous).toEqual([{ hash: 'aaaaaaaaaaaa', embed: `![[${oldName}]]` }]);
    expect(listFiledScans(s.text.get(NOTE)!)).toHaveLength(2);
  });

  it('a new image does not take the name an earlier entry still links (#433)', async () => {
    const s = setup(
      { [NOTE]: NOTE_TEXT },
      { 'old.jpg': [page(pagePayload(), 'aaaaaaaaaaaa')], 'new.jpg': [page(pagePayload(), 'bbbbbbbbbbbb')] },
    );
    const [old] = await s.pipeline.run([input('old.jpg')]);
    s.images.delete(old.imagePath!);
    const [next] = await s.pipeline.run([input('new.jpg')]);
    expect(next.imagePath).not.toBe(old.imagePath);
    expect(next.imagePath).toMatch(/_2\.jpg$/);
  });

  it('reuses an image left behind without its entry for the same bytes, without a _2 (#483)', async () => {
    const s = setup({ [NOTE]: NOTE_TEXT }, { 'a.jpg': [page(pagePayload(), 'aaaaaaaaaaaa')] });
    const [first] = await s.pipeline.run([input('a.jpg')]);
    s.text.set(NOTE, NOTE_TEXT);
    const [again] = await s.pipeline.run([input('a.jpg')]);
    expect(again).toMatchObject({ status: 'filed', imagePath: first.imagePath });
    expect([...s.images.keys()]).toEqual([first.imagePath]);
  });

  it('two pages written in one import never share an image', async () => {
    const s = setup(
      { [NOTE]: NOTE_TEXT },
      { 'a.jpg': [page(pagePayload(), 'aaaaaaaaaaaa')], 'b.jpg': [page(pagePayload(), 'bbbbbbbbbbbb')] },
    );
    const [a, b] = await s.pipeline.run([input('a.jpg'), input('b.jpg')]);
    expect(b.imagePath).not.toBe(a.imagePath);
    expect(s.images.size).toBe(2);
  });

  it('queues a saved image when its block is renamed while the page renders', async () => {
    let rendered!: () => void;
    let resume!: () => void;
    const started = new Promise<void>((r) => (rendered = r));
    const paused = new Promise<void>((r) => (resume = r));
    const s = setup(
      { [NOTE]: NOTE_TEXT },
      {
        'race.jpg': [
          page(pagePayload({ fingerprint: unitOpFingerprint('Gel', 'run') }), 'aaaaaaaaaaaa', {
            render: async () => {
              rendered();
              await paused;
              return bytesOf(4, 5, 6);
            },
          }),
        ],
        'good.jpg': [page(pagePayload({ unitOpIndex: 1, opId: 'UHW010' }), 'bbbbbbbbbbbb')],
      },
    );
    const running = s.pipeline.run([input('race.jpg'), input('good.jpg')]);
    await started;
    s.text.set(NOTE, NOTE_TEXT.replace('### [UHW020 Gel] run', '### [UHW020 Gel] stain'));
    resume();
    const [lost, good] = await running;
    expect(lost).toMatchObject({ status: 'unmatched', reason: 'renamed' });
    expect(lost.imagePath).toBeUndefined();
    expect(good.status).toBe('filed');
    expect(listFiledScans(s.text.get(NOTE)!).map((f) => f.hash)).toEqual(['bbbbbbbbbbbb']);
    expect(new Uint8Array(s.images.get(lost.unmatchedPath!)!)).toEqual(new Uint8Array([4, 5, 6]));
    expect([...s.images.keys()].sort()).toEqual([lost.unmatchedPath!, good.imagePath!].sort());
    expect(s.fs.trash).toHaveBeenCalledTimes(1);
  });

  it('a page whose ID two notes share goes to the queue as duplicate-id and neither note changes', async () => {
    const copy = 'e/02_copy.labnote.md';
    const s = setup({ [NOTE]: NOTE_TEXT, [copy]: NOTE_TEXT }, { 'a.jpg': [page(qr(`LN1:${ID}:1:UHW010:1/1:261015`), 'aaaaaaaaaaaa')] });
    const before1 = await s.fs.read(NOTE);
    const before2 = await s.fs.read(copy);
    const [r] = await s.pipeline.run([input('a.jpg')]);
    expect(r).toMatchObject({ status: 'unmatched', reason: 'duplicate-id' });
    expect(await s.fs.read(NOTE)).toBe(before1);
    expect(await s.fs.read(copy)).toBe(before2);
    expect(s.imagesUnder('_labnote-scans/unmatched/')).toHaveLength(1);
    expect(s.processNote).not.toHaveBeenCalled();
  });

  it('a unit op moved to another index files by opId and fingerprint, and a renamed one asks', async () => {
    const fp = unitOpFingerprint('PCR', 'amp');
    const s = setup(
      { [NOTE]: NOTE_TEXT },
      {
        // Printed as the 2nd unit op; UHW010 is now the 1st.
        'moved.jpg': [page(qr(`LN1:${ID}:2:UHW010:1/1:261015:${fp}`), 'aaaaaaaaaaaa')],
        'legacy.jpg': [page(qr(`LN1:${ID}:2:UHW010:2/2:261015`), 'bbbbbbbbbbbb')],
        // Same op ID, but its name or alias changed since printing.
        'renamed.jpg': [page(qr(`LN1:${ID}:2:UHW020:1/1:261015:${unitOpFingerprint('Gel', 'old run')}`), 'cccccccccccc')],
      },
    );
    const before = s.text.get(NOTE)!;
    const [moved, legacy, renamed] = await s.pipeline.run(['moved.jpg', 'legacy.jpg', 'renamed.jpg'].map(input));
    expect(moved).toMatchObject({ status: 'filed', block: '[UHW010 PCR] amp', matchedBy: 'fingerprint', legacy: false });
    expect(legacy).toMatchObject({ status: 'filed', block: '[UHW010 PCR] amp', matchedBy: 'opId', legacy: true });
    // The plugin asks about a renamed block in the results (the unmatched queue), not during the run.
    expect(renamed).toMatchObject({ status: 'unmatched', reason: 'renamed' });
    expect(s.confirm).not.toHaveBeenCalled();
    const after = s.text.get(NOTE)!;
    const lines = after.split('\n');
    const pcr = lines.indexOf('### [UHW010 PCR] amp');
    const gel = lines.indexOf('### [UHW020 Gel] run');
    const entries = lines.map((l, i) => (l.startsWith('<!-- labnoteo-scan') ? i : -1)).filter((i) => i >= 0);
    expect(entries).toHaveLength(2);
    for (const i of entries) expect(i > pcr && i < gel).toBe(true);
    expect(after.slice(after.indexOf('### [UHW020 Gel] run'))).toBe(before.slice(before.indexOf('### [UHW020 Gel] run')));
  });

  it('a note-only QR files under ## Worksheet scans at the end of the note', async () => {
    // A whole-note page printed before the first unit op (unit op 0); a bare note QR (screen QR) is queued as note-only.
    const s = setup(
      { [NOTE]: NOTE_TEXT },
      {
        'whole.jpg': [page(qr(`LN1:${ID}:0:-:1/1:261015`), 'aaaaaaaaaaaa')],
        'label.jpg': [page(qr(`LN1:${ID}`), 'bbbbbbbbbbbb')],
      },
    );
    const [whole, label] = await s.pipeline.run([input('whole.jpg'), input('label.jpg')]);
    expect(whole.status).toBe('filed');
    expect(label).toMatchObject({ status: 'unmatched', reason: 'note-only' });
    const text = s.text.get(NOTE)!;
    const at = text.indexOf('\n## Worksheet scans\n') + 1;
    expect(at).toBeGreaterThan(0);
    expect(at).toBeGreaterThan(text.indexOf('### [UHW020 Gel] run'));
    expect(text.slice(at + '## Worksheet scans\n'.length)).toMatch(/^\n?<!-- labnoteo-scan page=1\/1 sha=aaaaaaaaaaaa -->\n!\[\[/);
  });

  it('one write per note per batch, with an HTML comment, the embed and the caption', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-15T03:00:00Z'));
    const s = setup(
      { [NOTE]: NOTE_TEXT },
      {
        'p1.jpg': [page(qr(`LN1:${ID}:1:UHW010:1/2:261015`), 'aaaaaaaaaaaa')],
        'p2.jpg': [page(qr(`LN1:${ID}:1:UHW010:2/2:261015`), 'bbbbbbbbbbbb')],
      },
    );
    const results = await s.pipeline.run([input('p1.jpg'), input('p2.jpg')]);
    expect(results.map((r) => r.status)).toEqual(['filed', 'filed']);
    expect(s.processNote).toHaveBeenCalledTimes(1);
    const text = s.text.get(NOTE)!;
    expect(text).toContain('<!-- labnoteo-scan page=1/2 sha=aaaaaaaaaaaa -->');
    expect(text).toContain('![[LN-7K3M9QX2_u1_p1_20261015.jpg|200]]');
    expect(text).toContain('*Printout 1/2 · printed 2026-10-15 · imported 2026-10-15 · p1.jpg · [[LN-7K3M9QX2_u1_p1_20261015.jpg|Open full size]]*');
  });

  it('the same page twice is a duplicate; a filed entry whose image was deleted is filed again (#432)', async () => {
    const same = page(qr(`LN1:${ID}:1:UHW010:1/1:261015`), 'aaaaaaaaaaaa');
    const s = setup({ [NOTE]: NOTE_TEXT }, { 'a.jpg': [same] });
    const [first] = await s.pipeline.run([input('a.jpg')]);
    expect(first.status).toBe('filed');
    s.processNote.mockClear();
    const [dup] = await s.pipeline.run([input('a.jpg')]);
    expect(dup.status).toBe('duplicate');
    expect(s.processNote).not.toHaveBeenCalled();
    s.images.delete(first.imagePath!);
    const [again] = await s.pipeline.run([input('a.jpg')]);
    expect(again).toMatchObject({ status: 'filed', replacedMissing: true, imagePath: first.imagePath });
    expect(listFiledScans(s.text.get(NOTE)!).map((f) => f.hash)).toEqual(['aaaaaaaaaaaa']);
    expect(s.images.has(again.imagePath!)).toBe(true);
  });

  it('a flush blocked by composition files the page after compositionend, once', async () => {
    vi.useFakeTimers();
    const s = setup({ [NOTE]: NOTE_TEXT }, { 'a.jpg': [page(qr(`LN1:${ID}:1:UHW010:1/1:261015`), 'aaaaaaaaaaaa')] });
    s.setBusy(2);
    const running = s.pipeline.run([input('a.jpg')]);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    const [r] = await running;
    expect(r.status).toBe('filed');
    expect(s.processNote).toHaveBeenCalledTimes(3);
    expect(listFiledScans(s.text.get(NOTE)!)).toHaveLength(1);
    expect(s.imagesUnder('_labnote-scans/')).toEqual([]);
  });

  it('a note busy for 30 s re-queues the page as unmatched and trashes its stored image', async () => {
    vi.useFakeTimers();
    const s = setup({ [NOTE]: NOTE_TEXT }, { 'a.jpg': [page(qr(`LN1:${ID}:1:UHW010:1/1:261015`), 'aaaaaaaaaaaa')] });
    s.setBusy(Infinity);
    let settled = false;
    const running = s.pipeline.run([input('a.jpg')]).finally(() => (settled = true));
    await vi.advanceTimersByTimeAsync(29_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    const [r] = await running;
    expect(r).toMatchObject({ status: 'unmatched', reason: 'note-busy' });
    expect(r.imagePath).toBeUndefined();
    expect(s.fs.trash).toHaveBeenCalledWith(expect.stringMatching(/^e\/images\/scans\/LN-7K3M9QX2_u1_p1_\d{8}\.jpg$/));
    expect(s.imagesUnder('_labnote-scans/unmatched/')).toHaveLength(1);
    expect(s.imagesUnder('e/images/scans/')).toEqual([]);
    expect(r.unmatchedPath).toBe(s.imagesUnder('_labnote-scans/unmatched/')[0]);
    expect(s.text.get(NOTE)).toBe(NOTE_TEXT);
  });

  it('blank pages are skipped and foreign QR codes are unmatched', async () => {
    // The decoder hands a foreign QR (not LN1:) on as a page without a payload; the plugin queues it as no-qr.
    const s = setup(
      { [NOTE]: NOTE_TEXT },
      { 'scan.pdf': [page(undefined, '111111111111', { blank: true, sourcePage: 1 }), page(undefined, '222222222222', { sourcePage: 2 })] },
    );
    const results = await s.pipeline.run([input('scan.pdf')]);
    expect(results.map((r) => [r.status, r.reason])).toEqual([
      ['blank', undefined],
      ['unmatched', 'no-qr'],
    ]);
    expect(s.imagesUnder('_labnote-scans/unmatched/')).toHaveLength(1);
    expect(s.processNote).not.toHaveBeenCalled();
  });

  it('filing stamps last_updated_date in the same write only when the setting is on', async () => {
    const dated = NOTE_TEXT.replace('---\n###', 'last_updated_date: 2026-01-01\n---\n###');
    const pages = { 'a.jpg': [page(qr(`LN1:${ID}:1:UHW010:1/1:261015`), 'aaaaaaaaaaaa')] };
    const on = setup({ [NOTE]: dated }, pages, { autoUpdateLastUpdated: true });
    await on.pipeline.run([input('a.jpg')]);
    expect(on.processNote).toHaveBeenCalledTimes(1);
    expect(on.text.get(NOTE)).toContain(`last_updated_date: ${getSeoulDateString()}`);
    expect(listFiledScans(on.text.get(NOTE)!)).toHaveLength(1);

    const off = setup({ [NOTE]: dated }, pages, { autoUpdateLastUpdated: false });
    await off.pipeline.run([input('a.jpg')]);
    expect(off.text.get(NOTE)).toContain('last_updated_date: 2026-01-01');
    expect(listFiledScans(off.text.get(NOTE)!)).toHaveLength(1);
  });

  it('a hostile source name gives a single-line caption and no new heading', async () => {
    const hostile = 'a\n## X [[b]] -->.jpg';
    const s = setup({ [NOTE]: NOTE_TEXT }, { [hostile]: [page(qr(`LN1:${ID}:1:UHW010:1/1:261015`), 'aaaaaaaaaaaa')] });
    const [r] = await s.pipeline.run([input(hostile)]);
    expect(r.status).toBe('filed');
    const lines = s.text.get(NOTE)!.split('\n');
    expect(lines.some((l) => l.startsWith('## X'))).toBe(false);
    const at = lines.indexOf('<!-- labnoteo-scan page=1/1 sha=aaaaaaaaaaaa -->');
    expect(at).toBeGreaterThan(0);
    expect(lines[at + 1]).toMatch(/^!\[\[LN-7K3M9QX2_u1_p1_\d{8}\.jpg\|200\]\]$/);
    const caption = lines[at + 2];
    expect(caption).toMatch(/^\*Printout 1\/1 · printed 2026-10-15 · imported .* · a__ X __b__ --_\.jpg · \[\[.*\|Open full size\]\]\*$/);
    expect(caption.replace(/\[\[[^\]]*\|Open full size\]\]/, '')).not.toMatch(/\[\[|-->/);
    expect(listFiledScans(s.text.get(NOTE)!).map((f) => f.hash)).toEqual(['aaaaaaaaaaaa']);
    expect(safeSourceName('dir\\sub/a\n## X [[b]] -->.jpg')).not.toMatch(/[\n[\]|<>#^`\\/]/);
    expect(safeSourceName('dir\\sub/a\n## X [[b]] -->.jpg')).toBe('a__ X __b__ --_.jpg');
    expect(safeSourceName('x'.repeat(200) + '.jpg')).toHaveLength(120);
  });
});

describe('ScanPipeline.undo and removePrevious (vendor scanPipeline.test.ts)', () => {
  const pp = (over: Partial<PagePayload> = {}): PagePayload => ({
    noteId: ID,
    unitOpIndex: 2,
    opId: 'UHW020',
    page: 1,
    pageCount: 1,
    printedOn: '2026-10-15',
    ...over,
  });

  it('undoes a filed scan: removes its lines and trashes its image', async () => {
    const s = setup({ [NOTE]: NOTE_TEXT }, { 'a.jpg': [page(pp(), 'aaaaaaaaaaaa')] });
    const [result] = await s.pipeline.run([input('a.jpg')]);
    s.processNote.mockClear();
    expect(await s.pipeline.undo(result)).toBe(true);
    expect(s.text.get(NOTE)).not.toContain('aaaaaaaaaaaa');
    expect(s.fs.trash).toHaveBeenCalledWith(result.imagePath);
    expect(s.images.has(result.imagePath!)).toBe(false);
    expect(s.processNote).toHaveBeenCalledTimes(1);
  });

  it('undo removes the entry and trashes the image; a second undo is false', async () => {
    const s = setup({ [NOTE]: NOTE_TEXT }, { 'a.jpg': [page(pp(), 'aaaaaaaaaaaa')] });
    const [result] = await s.pipeline.run([input('a.jpg')]);
    expect(await s.pipeline.undo(result)).toBe(true);
    expect(s.text.get(NOTE)).toBe(NOTE_TEXT);
    expect(s.fs.trash).toHaveBeenCalledTimes(1);
    expect(s.fs.trash).toHaveBeenCalledWith(result.imagePath);
    expect(await s.pipeline.undo(result)).toBe(false);
    expect(s.fs.trash).toHaveBeenCalledTimes(1);
    expect(s.text.get(NOTE)).toBe(NOTE_TEXT);
  });

  it('undo of a result that was not filed does nothing', async () => {
    const s = setup({ [NOTE]: NOTE_TEXT }, {});
    const r: ScanResult = { source: 'x.jpg', status: 'duplicate', notePath: NOTE, hash: 'aaaaaaaaaaaa' };
    expect(await s.pipeline.undo(r)).toBe(false);
    expect(s.processNote).not.toHaveBeenCalled();
    expect(s.fs.trash).not.toHaveBeenCalled();
  });

  it('undo and Delete earlier scan stamp last_updated_date only when the setting is on', async () => {
    const dated = NOTE_TEXT.replace('---\n###', 'last_updated_date: 2026-01-01\n---\n###');
    const pages = { 'old.jpg': [page(pp(), 'aaaaaaaaaaaa')], 'new.jpg': [page(pp(), 'bbbbbbbbbbbb')] };
    const back = (s: ReturnType<typeof setup>) =>
      s.text.set(NOTE, s.text.get(NOTE)!.replace(/^last_updated_date: .*$/m, 'last_updated_date: 2026-01-01'));

    for (const on of [true, false]) {
      const s = setup({ [NOTE]: dated }, pages, { autoUpdateLastUpdated: on });
      await s.pipeline.run([input('old.jpg')]);
      const [next] = await s.pipeline.run([input('new.jpg')]);
      expect(next.previous).toHaveLength(1);

      back(s);
      s.processNote.mockClear();
      expect(await s.pipeline.removePrevious(next)).toBe(1);
      expect(s.processNote).toHaveBeenCalledTimes(1);
      expect(s.text.get(NOTE)).toContain(`last_updated_date: ${on ? getSeoulDateString() : '2026-01-01'}`);

      back(s);
      s.processNote.mockClear();
      expect(await s.pipeline.undo(next)).toBe(true);
      expect(s.processNote).toHaveBeenCalledTimes(1);
      expect(s.text.get(NOTE)).toContain(`last_updated_date: ${on ? getSeoulDateString() : '2026-01-01'}`);
      expect(listFiledScans(s.text.get(NOTE)!)).toEqual([]);
    }
  });

  it('Delete earlier scan removes the earlier entries of the page and trashes their images', async () => {
    const s = setup({ [NOTE]: NOTE_TEXT }, { 'old.jpg': [page(pp(), 'aaaaaaaaaaaa')], 'new.jpg': [page(pp(), 'bbbbbbbbbbbb')] });
    const [old] = await s.pipeline.run([input('old.jpg')]);
    const [next] = await s.pipeline.run([input('new.jpg')]);
    expect(await s.pipeline.removePrevious(next)).toBe(1);
    expect(next.previous).toEqual([]);
    expect(s.fs.trash).toHaveBeenCalledWith(old.imagePath);
    expect(s.images.has(old.imagePath!)).toBe(false);
    expect(s.images.has(next.imagePath!)).toBe(true);
    expect(listFiledScans(s.text.get(NOTE)!).map((f) => f.hash)).toEqual(['bbbbbbbbbbbb']);
    expect(await s.pipeline.removePrevious(next)).toBe(0);
  });

  // #433: a new image must not take the name an earlier entry still links.
  it('keeps the new image when the earlier scan of the page lost its own', async () => {
    const s = setup({ [NOTE]: NOTE_TEXT }, { 'old.jpg': [page(pp(), 'aaaaaaaaaaaa')], 'new.jpg': [page(pp(), 'bbbbbbbbbbbb')] });
    const [old] = await s.pipeline.run([input('old.jpg')]);
    s.images.delete(old.imagePath!);
    const [next] = await s.pipeline.run([input('new.jpg')]);
    expect(next.imagePath).toMatch(/_2\.jpg$/);
    expect(await s.pipeline.removePrevious(next)).toBe(1);
    expect(s.images.has(next.imagePath!)).toBe(true);
    expect(s.fs.trash).not.toHaveBeenCalled();
    expect(listFiledScans(s.text.get(NOTE)!).map((f) => f.hash)).toEqual(['bbbbbbbbbbbb']);
  });
});

// #234: a page filed by hand has no QR code to tell when it was printed.
describe('ScanPipeline.fileManually (vendor scanPipeline.test.ts)', () => {
  const QUEUED = '_labnote-scans/unmatched/20261021-021738_unknown_photo1.jpg';
  const item = (path: string) => ({ path, name: path.slice(path.lastIndexOf('/') + 1) });
  const ref = (path: string) => ({ path, basename: path.slice(path.lastIndexOf('/') + 1, -3), ctime: 1 });
  const target = (unitOpIndex: number, printedOn?: string) => ({
    note: ref(NOTE),
    unitOpIndex,
    page: { page: 1, pageCount: 1 },
    ...(printedOn ? { printedOn } : {}),
  });

  function manualSetup(notes: Record<string, string> = { [NOTE]: NOTE_TEXT }) {
    const s = setup(notes, {});
    s.images.set(QUEUED, new Uint8Array([9, 9, 9]));
    return s;
  }

  it('leaves the print date out of the caption when it is not known', async () => {
    const s = manualSetup();
    const result = await s.pipeline.fileManually(item(QUEUED), target(1));
    expect(result.status).toBe('filed');
    const text = s.text.get(NOTE)!;
    // #396: the caption names the photo, not the queue's stamped name.
    expect(text).toMatch(/\*Printout 1\/1 · imported \d{4}-\d{2}-\d{2} · photo1\.jpg · /);
    expect(text).not.toContain('printed');
  });

  // #341: a page filed by hand was always taken for a printout from before 0.123.0.
  it('carries the chosen block, so it is neither an old printout nor moved', async () => {
    const s = manualSetup();
    const result = await s.pipeline.fileManually(item(QUEUED), target(2));
    expect(result).toMatchObject({ status: 'filed', block: '[UHW020 Gel] run', matchedBy: 'index', legacy: false });
  });

  it.each(['before filing', 'during rendering'])(
    'leaves the image in the queue, with no second copy, when the block changes %s',
    async (timing) => {
      const s = manualSetup();
      const pipeline = s.pipeline as unknown as { filePage: (...args: unknown[]) => Promise<unknown> };
      const filePage = pipeline.filePage.bind(s.pipeline);
      pipeline.filePage = async (...args: unknown[]) => {
        const rename = () => s.text.set(NOTE, s.text.get(NOTE)!.replace('### [UHW020 Gel] run', '### [UHW020 Gel] 바뀜'));
        if (timing === 'before filing') rename();
        else {
          const decoded = args[0] as DecodedPage;
          const render = decoded.render;
          decoded.render = async () => {
            rename();
            return render();
          };
        }
        return filePage(...args);
      };
      const result = await s.pipeline.fileManually(item(QUEUED), target(2));
      expect(result).toMatchObject({ status: 'unmatched', reason: 'renamed', unmatchedPath: QUEUED });
      expect([...s.images.keys()]).toEqual([QUEUED]);
    },
  );

  // #495: the page filed by hand got the hash of the queue's JPEG, so importing the scan again missed it.
  it('records the hash and the name the scan was imported with, and knows the page when it comes again', async () => {
    const renamed: PagePayload = { noteId: ID, unitOpIndex: 2, opId: 'UHW020', page: 1, pageCount: 1, printedOn: '2026-10-15', fingerprint: 'ZZZZ' };
    const s = setup({ [NOTE]: NOTE_TEXT }, { 'scan_1-1.png': [page(renamed, '953d461ec519')] });
    const [first] = await s.pipeline.run([input('scan_1-1.png')]);
    expect(first).toMatchObject({ status: 'unmatched', reason: 'renamed' });
    expect(first.unmatchedPath).toContain('_renamed_h953d461ec519-png_scan_1-1.jpg');

    const result = await s.pipeline.fileManually(item(first.unmatchedPath!), target(2));
    expect(result).toMatchObject({ status: 'filed', hash: '953d461ec519' });
    expect(s.text.get(NOTE)!).toMatch(/· scan_1-1\.png · /);
    expect(s.images.has(first.unmatchedPath!)).toBe(false);

    const again = await s.pipeline.run([input('scan_1-1.png')]);
    expect(again.map((r) => r.status)).toEqual(['duplicate']);
  });

  it('writes the print date the user gave', async () => {
    const s = manualSetup();
    await s.pipeline.fileManually(item(QUEUED), target(1, '2026-09-30'));
    expect(s.text.get(NOTE)!).toContain('*Printout 1/1 · printed 2026-09-30 · imported ');
  });

  it('fileManually assigns an ID first and trashes the queue image when filed', async () => {
    const bare = NOTE_TEXT.replace(`labnote_id: ${ID}\n`, 'title: x\n');
    const s = manualSetup({ [NOTE]: bare });
    const result = await s.pipeline.fileManually(item(QUEUED), target(1));
    expect(result.status).toBe('filed');
    const id = readNoteId(frontMatterText(s.text.get(NOTE)!));
    expect(id).toMatch(/^LN-[0-9A-Z]{8}$/);
    expect(result.payload).toMatchObject({ noteId: id, unitOpIndex: 1, opId: 'UHW010' });
    expect(listFiledScans(s.text.get(NOTE)!)).toHaveLength(1);
    expect(s.fs.trash).toHaveBeenCalledWith(QUEUED);
    expect(s.images.has(QUEUED)).toBe(false);
    expect(s.images.has(result.imagePath!)).toBe(true);
  });

  // #267: cancelling the "restore the old ID?" question is not a failure and must not give the note a new ID.
  it('leaves the note and the queued image alone when the ID question is cancelled', async () => {
    const s = manualSetup();
    await s.pipeline.fileManually(item(QUEUED), target(1));
    const lost = s.text.get(NOTE)!.replace(/^labnote_id: .*\n/m, '');
    s.text.set(NOTE, lost);
    const SECOND = '_labnote-scans/unmatched/20261021-021800_unknown_photo2.jpg';
    s.images.set(SECOND, new Uint8Array([7, 7, 7]));
    // The host's pick closes without a choice (undefined): cancelled.
    const result = await s.pipeline.fileManually(item(SECOND), target(1));
    expect(result).toEqual({ source: '20261021-021800_unknown_photo2.jpg', status: 'skipped', reason: 'cancelled' });
    expect(s.text.get(NOTE)).toBe(lost);
    expect(s.images.has(SECOND)).toBe(true);
  });
});

describe('unzipScans', () => {
  it('takes images and PDFs by file name, skipping folders, dotfiles and other files', () => {
    const zip = zipSync({
      'b/IMG_2.jpg': strToU8('two'),
      'IMG_10.jpg': strToU8('ten'),
      'IMG_1.JPG': strToU8('one'),
      'scan.pdf': strToU8('pdf'),
      'notes.txt': strToU8('x'),
      '__MACOSX/._IMG_1.JPG': strToU8('meta'),
      '.hidden.jpg': strToU8('h'),
    });
    const { files, overLimit } = unzipScans(zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength) as ArrayBuffer);
    expect(overLimit).toBe(false);
    expect(files.map((f) => f.name)).toEqual(['IMG_1.JPG', 'IMG_2.jpg', 'IMG_10.jpg', 'scan.pdf']);
    expect(new TextDecoder().decode(files[1].bytes)).toBe('two');
  });

  it('stops at the entry limit and says so', () => {
    expect(ZIP_LIMITS).toEqual({ entries: 200, entryBytes: 100 * 1024 * 1024, totalBytes: 500 * 1024 * 1024 });
    const many: Record<string, Uint8Array> = {};
    for (let i = 0; i < 201; i++) many[`${i}.jpg`] = strToU8('x');
    const zip = zipSync(many);
    const { files, overLimit } = unzipScans(zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength) as ArrayBuffer);
    expect(files).toHaveLength(200);
    expect(overLimit).toBe(true);
  });
});

describe('embedLinkPath', () => {
  it('reads the path of wiki and markdown image embeds', () => {
    expect(embedLinkPath('![[images/scans/a.jpg|300]]')).toBe('images/scans/a.jpg');
    expect(embedLinkPath('![](images/scans/my%20scan.jpg)')).toBe('images/scans/my scan.jpg');
    expect(embedLinkPath('![](<images/scans/a b.jpg>)')).toBe('images/scans/a b.jpg');
    expect(embedLinkPath('plain text')).toBeUndefined();
  });
});
