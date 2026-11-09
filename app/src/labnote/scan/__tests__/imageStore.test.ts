import { describe, expect, it, vi } from 'vitest';
import {
  HASH_LENGTH,
  SCANS_SUBFOLDER,
  UNMATCHED_FOLDER,
  freeName,
  isScanOfNote,
  noteIdFromFiledScanEmbed,
  noteIdFromUnmatchedName,
  saveBinary,
  scanFileName,
  sha256Hex,
  shortHash,
  sourceNameFromUnmatched,
  timestamp,
  unmatchedFileName,
  unmatchedInfoFromName,
  type ImageStoreDeps,
} from '../../port/imageStore';

/** 보관함 하나를 흉내 낸다: 경로 → 바이트, 경로 → 그 경로를 가리키는 노트들. */
function memVault(files: Record<string, number[]> = {}, links: Record<string, string[]> = {}) {
  const store = new Map<string, Uint8Array>(Object.entries(files).map(([p, b]) => [p, new Uint8Array(b)]));
  const deps: ImageStoreDeps = {
    exists: vi.fn(async (path: string) => store.has(path)),
    readBinary: vi.fn(async (path: string) => {
      const b = store.get(path);
      if (!b) throw { kind: 'notFound', message: path };
      return b.slice().buffer;
    }),
    writeScanImage: vi.fn(async (dir: string, name: string, bytes: Uint8Array) => {
      const path = `${dir}/${name}`;
      if (store.has(path)) throw { kind: 'exists', message: path };
      store.set(path, bytes.slice());
      return path;
    }),
    backlinks: vi.fn((path: string) => (links[path] ?? []).map((source) => ({ source }))),
  };
  return { store, deps };
}

const bytes = (...b: number[]) => new Uint8Array(b).buffer;

describe('scan file names (vendor barcode.test.ts)', () => {
  it("names a scan after its note, unit operation and page, so moves can find a note's scans", () => {
    const name = scanFileName('LN-7K3M9QX2', 3, 2, '2026-10-15');
    expect(name).toBe('LN-7K3M9QX2_u3_p2_20261015.jpg');
    expect(isScanOfNote(name, 'LN-7K3M9QX2')).toBe(true);
    expect(isScanOfNote('LN-7K3M9QX2_u3_p2_20261015_2.jpg', 'LN-7K3M9QX2')).toBe(true);
    expect(isScanOfNote(name, 'LN-00000000')).toBe(false);
    expect(isScanOfNote('LN-7K3M9QX2_notes.md', 'LN-7K3M9QX2')).toBe(false);
    expect(noteIdFromFiledScanEmbed('![[LN-7K3M9QX2_u3_p2_20261015_2.jpg|200]]')).toBe('LN-7K3M9QX2');
  });

  it('keeps the note ID read from an unmatched page in its queue file name', () => {
    const name = unmatchedFileName('20261016-093012', 'IMG:1234.jpg', 'LN-7K3M9QX2', 2);
    expect(name).toBe('20261016-093012_LN-7K3M9QX2_IMG_1234_p2.jpg');
    expect(noteIdFromUnmatchedName(name)).toBe('LN-7K3M9QX2');
    expect(noteIdFromUnmatchedName(unmatchedFileName('20261016-093012', 'a.jpg', undefined))).toBeUndefined();
  });

  it('keeps what the QR code said and why the page was not filed (#349)', () => {
    const payload = {
      noteId: 'LN-7K3M9QX2',
      unitOpIndex: 2,
      opId: 'UHW290',
      page: 1,
      pageCount: 3,
      printedOn: '2026-10-25',
      fingerprint: 'K7QD',
    };
    const name = unmatchedFileName('20261025-073505', 'IMG_9.jpg', payload.noteId, undefined, { payload, reason: 'renamed' });
    expect(name).toBe('20261025-073505_LN-7K3M9QX2_q2-UHW290-1o3-261025-K7QD_renamed_IMG_9.jpg');
    const { noteId, ...page } = payload;
    expect(unmatchedInfoFromName(name)).toEqual({ noteId, page, reason: 'renamed' });
    expect(unmatchedInfoFromName('20261016-093012_LN-7K3M9QX2_renamed_x.jpg')).toEqual({
      noteId: 'LN-7K3M9QX2',
      reason: 'renamed',
    });
    expect(unmatchedInfoFromName('20261016-093012_unknown_no-qr_a.jpg')).toEqual({ reason: 'no-qr' });
    expect(unmatchedInfoFromName('20261016-093012_LN-7K3M9QX2_IMG_1234_p2.jpg')).toEqual({ noteId: 'LN-7K3M9QX2' });
  });

  it('drops a reason the queue does not know', () => {
    expect(unmatchedFileName('20261016-093012', 'a.jpg', undefined, undefined, { reason: 'made-up' })).toBe(
      '20261016-093012_unknown_a.jpg',
    );
  });

  it('gives back the source name at the end of a queue file name (#396)', () => {
    expect(sourceNameFromUnmatched('20261025-073505_LN-7K3M9QX2_q2-UHW290-1o3-261025-K7QD_renamed_IMG_9.jpg')).toBe(
      'IMG_9.jpg',
    );
    expect(sourceNameFromUnmatched('20261016-093012_unknown_photo1.jpg')).toBe('photo1.jpg');
    expect(sourceNameFromUnmatched('IMG_9.jpg')).toBe('IMG_9.jpg');
  });

  it('keeps the hash and the extension of the scanned file (#495)', () => {
    const name = unmatchedFileName('20261031-185455', 'scan_1-1.png', 'LN-7K3M9QX2', undefined, {
      reason: 'renamed',
      hash: '953d461ec519',
    });
    expect(name).toBe('20261031-185455_LN-7K3M9QX2_renamed_h953d461ec519-png_scan_1-1.jpg');
    expect(unmatchedInfoFromName(name)).toEqual({
      noteId: 'LN-7K3M9QX2',
      reason: 'renamed',
      hash: '953d461ec519',
      sourceExt: 'png',
    });
    expect(sourceNameFromUnmatched(name)).toBe('scan_1-1.png');
    const pdf = unmatchedFileName('20261031-185455', 'run.pdf', undefined, 2, { hash: 'aaaaaaaaaaaa' });
    expect(sourceNameFromUnmatched(pdf)).toBe('run.pdf p.2');
    expect(
      sourceNameFromUnmatched(unmatchedFileName('20261031-185455', 'IMG_p2.png', undefined, undefined, { hash: 'aaaaaaaaaaaa' })),
    ).toBe('IMG_p2.png');
  });
});

describe('store constants and helpers', () => {
  it('keeps the plugin folders and hash length', () => {
    expect(SCANS_SUBFOLDER).toBe('images/scans');
    expect(UNMATCHED_FOLDER).toBe('_labnote-scans/unmatched');
    expect(HASH_LENGTH).toBe(12);
  });

  it('hashes bytes with SHA-256 and shortens to 12 hex digits', async () => {
    const hex = await sha256Hex(new TextEncoder().encode('abc'));
    expect(hex).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(shortHash(hex)).toBe('ba7816bf8f01');
  });

  it('freeName picks name, then name_2, name_3 before the extension', () => {
    expect(freeName('a.jpg', () => false)).toBe('a.jpg');
    const taken = new Set(['a.jpg', 'a_2.jpg']);
    expect(freeName('a.jpg', (n) => taken.has(n))).toBe('a_3.jpg');
    expect(freeName('noext', (n) => n === 'noext')).toBe('noext_2');
  });

  it('timestamp is local YYYYMMDD-HHMMSS', () => {
    expect(timestamp(new Date(2026, 9, 16, 9, 30, 12))).toBe('20261016-093012');
  });
});

describe('saveBinary', () => {
  it('saveBinary takes name_2 when the name is taken and reuses an unlinked identical twin (#483)', async () => {
    // a.jpg exists with other bytes and a backlink → the write goes to a_2.jpg
    const v1 = memVault({ 'e/images/scans/a.jpg': [9, 9] }, { 'e/images/scans/a.jpg': ['e/01_x.labnote.md'] });
    const f1 = await saveBinary(v1.deps, 'e/images/scans', 'a.jpg', bytes(1, 2, 3), undefined, { skip: new Set() });
    expect(f1).toEqual({ path: 'e/images/scans/a_2.jpg', name: 'a_2.jpg' });
    expect(Array.from(v1.store.get('e/images/scans/a_2.jpg')!)).toEqual([1, 2, 3]);
    expect(Array.from(v1.store.get('e/images/scans/a.jpg')!)).toEqual([9, 9]);

    // a.jpg is linked, a_2.jpg differs, a_3.jpg holds the same bytes and no backlink → a_3.jpg, nothing written
    const v2 = memVault(
      { 'e/images/scans/a.jpg': [1, 2, 3], 'e/images/scans/a_2.jpg': [7], 'e/images/scans/a_3.jpg': [1, 2, 3] },
      { 'e/images/scans/a.jpg': ['e/01_x.labnote.md'] },
    );
    const f2 = await saveBinary(v2.deps, 'e/images/scans', 'a.jpg', bytes(1, 2, 3), undefined, { skip: new Set() });
    expect(f2).toEqual({ path: 'e/images/scans/a_3.jpg', name: 'a_3.jpg' });
    expect(v2.deps.writeScanImage).not.toHaveBeenCalled();
    expect(v2.store.size).toBe(3);
  });

  it('an image under the cap is written exactly once', async () => {
    const v = memVault();
    const data = bytes(0xff, 0xd8, 1);
    const f = await saveBinary(v.deps, 'e/images/scans', 'LN-7K3M9QX2_u1_p1_20261015.jpg', data);
    expect(v.deps.writeScanImage).toHaveBeenCalledTimes(1);
    expect(v.deps.writeScanImage).toHaveBeenCalledWith(
      'e/images/scans',
      'LN-7K3M9QX2_u1_p1_20261015.jpg',
      new Uint8Array(data),
    );
    expect(f.path).toBe('e/images/scans/LN-7K3M9QX2_u1_p1_20261015.jpg');
  });

  it('a name taken between the check and the write (exists) moves on to the next free name', async () => {
    const v = memVault();
    const real = v.deps.writeScanImage;
    let first = true;
    v.deps.writeScanImage = vi.fn(async (dir: string, name: string, b: Uint8Array) => {
      if (first) {
        first = false;
        v.store.set(`${dir}/${name}`, new Uint8Array([5]));
      }
      return real(dir, name, b);
    });
    const f = await saveBinary(v.deps, 'x', 'a.jpg', bytes(1));
    expect(f.path).toBe('x/a_2.jpg');
    expect(Array.from(v.store.get('x/a.jpg')!)).toEqual([5]);
  });

  it('other write errors are not swallowed', async () => {
    const v = memVault();
    v.deps.writeScanImage = vi.fn(async () => {
      throw { kind: 'tooLarge', message: 'big' };
    });
    await expect(saveBinary(v.deps, 'x', 'a.jpg', bytes(1))).rejects.toMatchObject({ kind: 'tooLarge' });
    expect(v.deps.writeScanImage).toHaveBeenCalledTimes(1);
  });

  it('skips names in avoid, and reuses no twin a note links or skip or avoid holds', async () => {
    const v = memVault(
      { 'd/a.jpg': [1], 'd/a_2.jpg': [1], 'd/a_3.jpg': [1] },
      { 'd/a.jpg': ['n.md'], 'd/a_2.jpg': ['board.canvas'] },
    );
    // a.jpg: linked by a note; a_2.jpg: linked only by a non-.md file, so reusable unless skipped; a_3.jpg: in avoid
    const f = await saveBinary(v.deps, 'd', 'a.jpg', bytes(1), new Set(['a_3.jpg', 'a_4.jpg']), {
      skip: new Set(['d/a_2.jpg']),
    });
    expect(f.path).toBe('d/a_5.jpg');
    expect(v.deps.writeScanImage).toHaveBeenCalledTimes(1);

    const reuse = await saveBinary(v.deps, 'd', 'a.jpg', bytes(1), undefined, { skip: new Set() });
    expect(reuse.path).toBe('d/a_2.jpg');
    expect(v.deps.writeScanImage).toHaveBeenCalledTimes(1);
  });

  it('normalizes the folder before writing', async () => {
    const v = memVault();
    const f = await saveBinary(v.deps, 'e//images/scans/', 'a.jpg', bytes(1));
    expect(v.deps.writeScanImage).toHaveBeenCalledWith('e/images/scans', 'a.jpg', expect.any(Uint8Array));
    expect(f.path).toBe('e/images/scans/a.jpg');
  });
});
