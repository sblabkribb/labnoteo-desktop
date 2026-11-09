// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import type { NotifyKind } from '@labnoteo/core';
import { decodeScanPayload, unitOpFingerprint } from '@labnoteo/core/lib/scanPayload';
import type { WorksheetPaperSize } from '../../../../vendor/labnoteo/src/settings';
import type { AppHost } from '../../host/createAppHost';
import { coreT, overrideOr } from '../../i18n';
import {
  printFullNoteCommand,
  sliceIntoPages,
  unitOpOfRenderedHeading,
  type FullNoteDeps,
  type MeasuredBlock,
} from '../../port/fullNotePrint';
import { escapeHtml, type PrintPage } from '../../port/printPages';
import { measureNoteBlocks } from '../measure';
import type { NoteImages } from '../noteBlocks';
import { printRoot } from '../printRoot';
import { noteImagesFor } from '../worksheetCommand';

describe('sliceIntoPages', () => {
  const block = (top: number, height: number, opId?: string): MeasuredBlock => ({ top, bottom: top + height, opId });

  it('cuts before the block that would overflow and names the unit operation each page starts in', () => {
    const blocks = [block(0, 40), block(40, 40), block(80, 40, 'UHW010'), block(120, 40), block(160, 40, 'UHW020'), block(200, 40)];
    expect(sliceIntoPages(blocks, 100)).toEqual([
      { from: 0, to: 2, unitOpIndex: 0, opId: '' },
      { from: 2, to: 4, unitOpIndex: 1, opId: 'UHW010' },
      { from: 4, to: 6, unitOpIndex: 2, opId: 'UHW020' },
    ]);
  });

  it('never leaves a unit-operation heading at the bottom of a page', () => {
    const blocks = [block(0, 50), block(50, 10, 'UHW010'), block(60, 60)];
    expect(sliceIntoPages(blocks, 100).map((p) => [p.from, p.to, p.opId])).toEqual([
      [0, 1, ''],
      [1, 3, 'UHW010'],
    ]);
  });

  // #359: the first page's scan filed at the note's end though it held the
  // first unit operation's Meta and Input.
  it('starts every unit operation on a new page, even with room left', () => {
    const blocks = [block(0, 10), block(10, 10), block(20, 10, 'UHW010'), block(30, 10), block(40, 10, 'UHW020'), block(50, 10)];
    expect(sliceIntoPages(blocks, 100).map((p) => [p.from, p.to, p.opId])).toEqual([
      [0, 2, ''],
      [2, 4, 'UHW010'],
      [4, 6, 'UHW020'],
    ]);
    expect(sliceIntoPages([block(0, 10, 'UHW010'), block(10, 10)], 100).map((p) => [p.from, p.to])).toEqual([[0, 2]]);
  });

  it('gives a block taller than a page a page of its own', () => {
    const blocks = [block(0, 30), block(30, 300), block(330, 30)];
    expect(sliceIntoPages(blocks, 100).map((p) => [p.from, p.to])).toEqual([
      [0, 1],
      [1, 2],
      [2, 3],
    ]);
    expect(sliceIntoPages([], 100)).toEqual([]);
  });

  it('carries the fingerprint of the unit operation each page starts in (#304)', () => {
    const blocks = [block(0, 40), { ...block(40, 40, 'UHW010'), fingerprint: 'K7QD' }, block(80, 40)];
    expect(sliceIntoPages(blocks, 50)).toEqual([
      { from: 0, to: 1, unitOpIndex: 0, opId: '' },
      { from: 1, to: 2, unitOpIndex: 1, opId: 'UHW010', fingerprint: 'K7QD' },
      { from: 2, to: 3, unitOpIndex: 1, opId: 'UHW010', fingerprint: 'K7QD' },
    ]);
  });
});

describe('unitOpOfRenderedHeading', () => {
  it('reads the ID and fingerprints the name and alias as the Markdown heading would', () => {
    expect(unitOpOfRenderedHeading('[UHW010 Liquid Handling] 2차 정제')).toEqual({
      opId: 'UHW010',
      fingerprint: unitOpFingerprint('Liquid Handling', '**2차** 정제'),
    });
    expect(unitOpOfRenderedHeading('[UHW010 Liquid Handling]')?.fingerprint).toBe(unitOpFingerprint('Liquid Handling', ''));
    expect(unitOpOfRenderedHeading('Method')).toBeUndefined();
  });
});

describe('printFullNoteCommand', () => {
  const PATH = 'e/01_wd.labnote.md';
  const ID = 'LN-7K3M9QX2';
  const NOTE = '---\ntitle: My <note>\n---\nIntro text.\n\n### [UHW010 PCR]\n\nAfter.\n\n![[a.png]]\n';

  interface Harness {
    deps: FullNoteDeps;
    notes: Array<{ kind: NotifyKind; message: string }>;
    events: string[];
    printed: Array<{ pages: PrintPage[]; paper: WorksheetPaperSize }>;
    opened: Array<{ kind: string; noteId: string; html: string }>;
    measured: string[][];
    released: () => number;
  }

  function harness(content: string, opts: { print?: () => Promise<void>; noteId?: string } = {}): Harness {
    const notes: Harness['notes'] = [];
    const events: string[] = [];
    const printed: Harness['printed'] = [];
    const opened: Harness['opened'] = [];
    const measured: string[][] = [];
    let released = 0;
    const host = { notify: (kind: NotifyKind, message: string) => notes.push({ kind, message }) } as unknown as AppHost;
    const images: NoteImages & { blob(src: string): Promise<Blob | undefined>; release(): void } = {
      src: (target) => (target === 'a.png' ? 'blob:tauri://localhost/img-1' : undefined),
      blob: async (src) => (src === 'blob:tauri://localhost/img-1' ? new Blob(['ab'], { type: 'image/png' }) : undefined),
      release: () => {
        released++;
      },
    };
    const deps: FullNoteDeps = {
      host,
      t: coreT,
      read: async () => {
        events.push('read');
        return content;
      },
      paper: () => 'a4',
      setPaper: async () => undefined,
      ensureNoteId: async () => {
        events.push('ensureNoteId');
        return 'noteId' in opts ? opts.noteId : ID;
      },
      choose: async () => undefined,
      print: async (pages, paper) => {
        events.push(`print:${paper}`);
        if (opts.print) await opts.print();
        printed.push({ pages, paper });
      },
      openInBrowser: async (kind, noteId, html) => {
        events.push(`open:${kind}`);
        opened.push({ kind, noteId, html });
      },
      // Blocks: [p, h3 [UHW010 PCR], p, img], each 10 px tall; a page is far taller, so the unit op alone cuts.
      measure: async (blocks) => {
        measured.push(blocks);
        return {
          pxPerMm: 1,
          blocks: blocks.map((b, i) => {
            const h = /^<h3>([^<]*)<\/h3>$/.exec(b);
            const op = h ? unitOpOfRenderedHeading(h[1]) : undefined;
            return { top: i * 10, bottom: i * 10 + 10, ...op };
          }),
        };
      },
      images: async (path, md) => {
        events.push(`images:${path}:${md === content}`);
        return images;
      },
    };
    return { deps, notes, events, printed, opened, measured, released: () => released };
  }

  it('builds page payloads with unit op 0 and "-" before the first unit op', async () => {
    const h = harness(NOTE);
    await printFullNoteCommand(h.deps, PATH);
    expect(h.events).toEqual(['ensureNoteId', 'read', `images:${PATH}:true`, 'print:a4']);
    expect(h.measured).toHaveLength(1);
    expect(h.measured[0]).toHaveLength(4);
    const pages = h.printed[0].pages;
    expect(pages).toHaveLength(2);
    expect(pages[0].payload).toMatch(/^LN1:LN-[0-9A-Z]{8}:0:-:1\/2:\d{6}$/);
    expect(pages[1].payload).toMatch(/^LN1:LN-7K3M9QX2:1:UHW010:2\/2:\d{6}:/);
    expect(decodeScanPayload(pages[1].payload)).toMatchObject({ unitOpIndex: 1, opId: 'UHW010', fingerprint: unitOpFingerprint('PCR', '') });
    expect(pages[0].body).toBe('<div class="note-body"><p>Intro text.</p></div>');
    expect(pages[1].body).toContain('<h3>[UHW010 PCR]</h3>');
    expect(pages[1].body).toContain('src="blob:tauri://localhost/img-1"');
    // Title, ID and page line in the header, escaped; the plugin's footer sentence.
    expect(pages[0].header).toContain(`<div class="muted">${ID}</div><div class="title">My &lt;note&gt;</div>`);
    const printedOn = (decodeScanPayload(pages[0].payload) as { printedOn: string }).printedOn;
    expect(pages[0].header).toContain(escapeHtml(coreT('Page {0} of {1} · printed {2}', '1', '2', printedOn)));
    expect(pages[0].footer).toBe(
      coreT('Write on this sheet, then photograph or scan it with a QR code visible and put the file in the scan folder.'),
    );
    expect(h.opened).toEqual([]);
    expect(h.notes).toEqual([]);
    expect(h.released()).toBe(1);
  });

  it('no note ID (refused or busy) reads, measures and prints nothing', async () => {
    const h = harness(NOTE, { noteId: undefined });
    await printFullNoteCommand(h.deps, PATH);
    expect(h.events).toEqual(['ensureNoteId']);
    expect(h.measured).toEqual([]);
  });

  it('an empty note says so and prints nothing', async () => {
    const h = harness('---\ntitle: x\n---\n\n');
    await printFullNoteCommand(h.deps, PATH);
    expect(h.notes).toEqual([{ kind: 'info', message: coreT('This note is empty.') }]);
    expect(h.printed).toEqual([]);
    expect(h.opened).toEqual([]);
    expect(h.released()).toBe(1);
  });

  it('a failing print opens <noteId>_note.html with data: images', async () => {
    const h = harness(NOTE, {
      print: async () => {
        throw new Error('no printer');
      },
    });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await printFullNoteCommand(h.deps, PATH);
    expect(h.opened).toHaveLength(1);
    const [{ kind, noteId, html }] = h.opened;
    expect([kind, noteId]).toEqual(['note', ID]);
    expect(html).toContain('data:image/png;base64,YWI=');
    expect(html).not.toContain('blob:');
    expect(html).toContain('<title>My &lt;note&gt;</title>');
    expect(h.notes).toEqual([{ kind: 'warn', message: overrideOr('print.openedInBrowser') }]);
    expect(h.released()).toBe(1);
  });
});

describe('measureNoteBlocks', () => {
  afterEach(() => printRoot().replaceChildren());

  it('measures each block in a sanitized .print-measure, names unit-op headings, then removes it', async () => {
    const seen: string[] = [];
    const root = printRoot();
    const observer = new MutationObserver((records) => {
      for (const r of records) for (const n of r.addedNodes) if (n instanceof HTMLElement) seen.push(n.className);
    });
    observer.observe(root, { childList: true });
    const r = await measureNoteBlocks(
      ['<p>a</p>', '<h3>[UHW010 PCR] alias</h3>', '<p><img src=x onerror="alert(1)">b</p>', '<h3>Method</h3>'],
      'letter',
      { waitMs: 10 },
    );
    await Promise.resolve();
    observer.disconnect();
    expect(seen).toEqual(['print-measure note-body letter']);
    expect(root.querySelector('.print-measure')).toBeNull();
    expect(r.blocks).toHaveLength(4);
    expect(r.blocks.map((b) => b.opId)).toEqual([undefined, 'UHW010', undefined, undefined]);
    expect(r.blocks[1].fingerprint).toBe(unitOpFingerprint('PCR', 'alias'));
    // jsdom has no layout: the scale falls back to CSS pixels per mm.
    expect(r.pxPerMm).toBeCloseTo(96 / 25.4);
  });
});

describe('print.css measure box', () => {
  it('gives .print-measure the body width of each paper, at 10pt / 1.5', () => {
    const css = readFileSync('src/labnote/print/print.css', 'utf-8');
    expect(css).toMatch(/\.print-root \.print-measure \{[^}]*font-size: 10pt;[^}]*line-height: 1\.5;/);
    expect(css).toMatch(/\.print-root \.print-measure\.a4 \{[^}]*width: 182mm/);
    expect(css).toMatch(/\.print-root \.print-measure\.letter \{[^}]*width: 187\.9mm/);
  });
});

describe('noteImagesFor', () => {
  it('reads each image paragraph once, hands out blob: URLs with their bytes, and revokes them on release', async () => {
    const reads: string[] = [];
    const revoked: string[] = [];
    let n = 0;
    const images = await noteImagesFor('e/01_x.labnote.md', '![[s.jpg]]\n\n![[missing.png]]\n\nSee ![[t.png]] here.\n', {
      read: async (p) => {
        reads.push(p);
        return new TextEncoder().encode('ab').buffer as ArrayBuffer;
      },
      list: async () => ['e/images/scans/s.jpg', 'e/t.png'],
      urls: { create: () => `blob:tauri://localhost/${++n}`, revoke: (u) => revoked.push(u) },
    });
    expect(reads).toEqual(['e/images/scans/s.jpg']);
    expect(images.src('s.jpg', 'wiki')).toBe('blob:tauri://localhost/1');
    expect(images.src('missing.png', 'wiki')).toBeUndefined();
    const blob = await images.blob!('blob:tauri://localhost/1');
    expect(blob?.type).toBe('image/jpeg');
    expect(await images.blob!('blob:other')).toBeUndefined();
    images.release!();
    expect(revoked).toEqual(['blob:tauri://localhost/1']);
    expect(await images.blob!('blob:tauri://localhost/1')).toBeUndefined();
  });
});
