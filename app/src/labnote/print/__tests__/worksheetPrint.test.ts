// @vitest-environment jsdom
import type { NotifyKind } from '@labnoteo/core';
import { decodeScanPayload, unitOpFingerprint } from '@labnoteo/core/lib/scanPayload';
import { buildHwUnitOpMarkdown, buildSwUnitOpMarkdown } from '@labnoteo/core/lib/unitOpTemplate';
import { listWorksheetUnitOps, paginateWorksheet, type WorksheetUnitOp } from '@labnoteo/core/lib/worksheet';
import { createWorkflowContent } from '@labnoteo/core/lib/workflowStructure';
import { findUnitOpInsertOffset, rebuildUnitOpToc } from '../../../../vendor/labnoteo/packages/labnoteo-core/src/sections/workflowSectionParser';
import type { WorksheetPaperSize } from '../../../../vendor/labnoteo/src/settings';
import type { AppHost } from '../../host/createAppHost';
import { coreT, overrideOr } from '../../i18n';
import { escapeHtml, FIT_SCRIPT, type PrintPage } from '../../port/printPages';
import {
  initialWorksheetSelection,
  noteTitleOf,
  plainInline,
  printWorksheetCommand,
  worksheetPrintPages,
  type WorksheetChoice,
  type WorksheetDeps,
} from '../../port/worksheetPrint';

const fmt = (s: string, ...args: Array<string | number | boolean>) => args.reduce<string>((acc, a, i) => acc.replace(`{${i}}`, String(a)), s);

describe('initialWorksheetSelection', () => {
  const op = (index: number, kind: 'hw' | 'sw') => ({ index, kind }) as WorksheetUnitOp;

  it('selects the lab unit operations, or every one when there are none', () => {
    expect(initialWorksheetSelection([op(1, 'sw'), op(2, 'hw'), op(3, 'hw')])).toEqual([2, 3]);
    expect(initialWorksheetSelection([op(1, 'sw'), op(2, 'sw')])).toEqual([1, 2]);
  });
});

/** A workflow note with the given unit-op blocks. */
function noteWith(blocks: string[]): string {
  let md = createWorkflowContent({ id: 'WD010', name: 'Design', description: 'desc' }, 'Dr. Kim', undefined, { noteId: 'LN-7K3M9QX2' });
  for (const block of blocks) {
    const off = findUnitOpInsertOffset(md);
    md = rebuildUnitOpToc(md.slice(0, off) + block + md.slice(off));
  }
  return md;
}

const meta = { experimenter: 'Dr. Kim', dateTime: '2026-10-15 10:00' };
const hw = (opId: string, opName = 'Electroporation') => buildHwUnitOpMarkdown({ opId, opName, opDescription: 'step' }, meta);
const sw = (opId: string) => buildSwUnitOpMarkdown({ opId, opName: `Op ${opId}`, opDescription: 'Code step' }, meta);

describe('worksheetPrintPages', () => {
  /** The printed body of a lab unit operation whose Markdown `edit` has rewritten. */
  function worksheetBody(edit: (md: string) => string): string {
    const pages = paginateWorksheet(listWorksheetUnitOps(edit(noteWith([hw('UHW090')]))));
    return worksheetPrintPages(pages, { noteTitle: 'Note', noteId: 'LN-7K3M9QX2', printedOn: '2026-10-15', t: fmt })
      .map((p) => p.body)
      .join('');
  }

  it('gives every page a QR naming the note, unit operation and page, and escapes note text', () => {
    const pages = paginateWorksheet(listWorksheetUnitOps(noteWith([hw('UHW010', 'Liquid <Handling>')])));
    const printed = worksheetPrintPages(pages, { noteTitle: 'A & B', noteId: 'LN-7K3M9QX2', printedOn: '2026-10-15', t: fmt });
    expect(printed).toHaveLength(pages.length);
    printed.forEach((p, i) => {
      expect(decodeScanPayload(p.payload)).toEqual({
        noteId: 'LN-7K3M9QX2',
        unitOpIndex: 1,
        opId: 'UHW010',
        page: i + 1,
        pageCount: pages.length,
        printedOn: '2026-10-15',
        fingerprint: unitOpFingerprint('Liquid <Handling>', ''),
      });
      expect(p.header).toContain('A &amp; B');
      expect(p.header).not.toContain('<Handling>');
      expect(p.header).toContain(fmt('Page {0} of {1} · printed {2}', i + 1, pages.length, '2026-10-15'));
    });
    expect(printed[0].header).toContain('Liquid &lt;Handling&gt;');
    expect(printed[0].header).toContain('<div>step</div>');
    expect(printed[0].body).toContain('<div class="sec g1"><h3>Reagent</h3><div class="fill"></div></div>');
  });

  it('marks pages after the first as continued and prints the description on page 1 only', () => {
    const long = Array.from({ length: 120 }, (_, i) => `${i + 1}. 단계 ${i + 1}`).join('\n');
    const pages = paginateWorksheet(
      listWorksheetUnitOps(noteWith([hw('UHW010')]).replace('#### Method\n- (method used in this step)', `#### Method\n${long}`)),
    );
    expect(pages.length).toBeGreaterThan(1);
    const printed = worksheetPrintPages(pages, { noteTitle: 'N', noteId: 'LN-7K3M9QX2', printedOn: '2026-10-15', t: fmt });
    expect(printed[0].header).not.toContain('(continued)');
    expect(printed[0].header).toContain('<div>step</div>');
    expect(printed[1].header).toContain('<span class="muted">(continued)</span>');
    expect(printed[1].header).not.toContain('<div>step</div>');
  });

  it('hands the leftover height to the sections written in by hand, Method and Results widest (#245)', () => {
    const body = worksheetBody((md) =>
      md.replace('#### Results & Discussions\n- (Any results and discussions. Link file path if needed)', '#### Results & Discussions\n수율 낮음'),
    );
    expect(body.startsWith('<div class="ws">')).toBe(true);
    expect(body).toContain('<div class="sec g2"><h3>Method</h3><div class="fill"></div></div>');
    expect(body).toContain('<div class="sec text g2"><h3>Results &amp; Discussions</h3><p>수율 낮음</p><div class="fill"></div></div>');
    expect(body).toContain('<div class="sec g1"><h3>Input</h3>');
    expect(body).toContain('<table class="meta">');
  });

  it("prints what is nested under a step below it and a step's table as a table (#254)", () => {
    const body = worksheetBody((md) =>
      md.replace(
        '#### Method\n- (method used in this step)',
        ['#### Method', '1. 컴피턴트 세포 준비', '    - 얼음 위 10분', '2. 전기천공 조건', '', '| 전압 | 큐벳 |', '| --- | --- |', '| 1.8 kV | 1 mm |'].join('\n'),
      ),
    );
    expect(body).toContain('<span class="n">2.</span><div class="s">전기천공 조건');
    expect(body).toContain('<ul class="sub"><li>얼음 위 10분</li></ul>');
    expect(body).toContain('<table class="grid"><tr><th>전압</th><th>큐벳</th></tr><tr><td>1.8 kV</td><td>1 mm</td></tr></table>');
    expect(body).not.toContain('| ---');
  });

  it("prints a text section's list with bullets instead of its Markdown marks (#253)", () => {
    const body = worksheetBody((md) =>
      md.replace('#### Equipment\n- (e.g. centrifuge, spectrophotometer, etc.)', '#### Equipment\n- Acoustic liquid dispenser\n  - 384-well head'),
    );
    expect(body).toContain('<ul class="bul"><li class="d0">Acoustic liquid dispenser</li><li class="d1">384-well head</li></ul>');
    expect(body).not.toContain('<p>- Acoustic');
  });

  it('reduces inline markdown to its text', () => {
    expect(plainInline('**Spin** `300 g` with [[DNA-1|plasmid]] see [doc](http://x) ![[img.png]]')).toBe('Spin 300 g with plasmid see doc [img.png]');
  });

  it('prints a code block as written, under its step, and ticks a checked step', () => {
    const body = worksheetBody((md) =>
      md.replace('#### Method\n- (method used in this step)', ['#### Method', '1. [x] 프로그램 실행', '```', '1. run --dry', '<b>', '```', '2. [ ] 결과 확인'].join('\n')),
    );
    expect(body).toContain('<span class="box done"></span><span class="n">1.</span>');
    expect(body).toContain('<pre class="code">1. run --dry\n&lt;b&gt;</pre>');
    expect(body).toContain('<span class="box"></span><span class="n">2.</span><div class="s">결과 확인');
    expect(body).not.toContain('<span class="n">3.</span>');
  });

  it('prints a callout as a box under its step and a quote with a rule, not as > marks', () => {
    const body = worksheetBody((md) =>
      md.replace('#### Method\n- (method used in this step)', ['#### Method', '1. 해동', '', '> [!warning] 얼음 위', '> **10분** 이내', '', '2. 원심', '> 천천히'].join('\n')),
    );
    expect(body).toContain('<div class="callout"><div class="callout-title"><b>Warning</b> 얼음 위</div><div>10분 이내</div></div>');
    expect(body).toContain('<blockquote class="quote"><div>천천히</div></blockquote>');
    expect(body).not.toContain('[!warning]');
  });

  it('gives a table above the first step no box or number', () => {
    const body = worksheetBody((md) =>
      md.replace('#### Method\n- (method used in this step)', ['#### Method', '| a |', '| --- |', '| 1 |', '', '1. 시작'].join('\n')),
    );
    expect(body).toContain('<li><div class="s"><table class="grid">');
    expect(body).toContain('<span class="n">1.</span><div class="s">시작');
  });

  it('shows inline formatting as the reading view does', () => {
    const body = worksheetBody((md) =>
      md.replace(
        '#### Results & Discussions\n- (Any results and discussions. Link file path if needed)',
        '#### Results & Discussions\nOD<sub>600</sub> ~~0.10~~ 0.12 ==확인== 455.1[^1] $3\\,mL$ &lt;0.1 `<sup>x</sup>` \\*a\\* *재측정* sample_id_1',
      ),
    );
    expect(body).toContain(
      '<p>OD<sub>600</sub> <s>0.10</s> 0.12 <mark>확인</mark> 455.1<sup>1</sup> 3 mL &lt;0.1 &lt;sup&gt;x&lt;/sup&gt; *a* <i>재측정</i> sample_id_1</p>',
    );
  });

  it('prints a footnote definition as the raised number its reference shows', () => {
    const body = worksheetBody((md) =>
      md.replace(
        '#### Results & Discussions\n- (Any results and discussions. Link file path if needed)',
        '#### Results & Discussions\n본문[^1]\n\n[^1]: 얼음에서 녹임',
      ),
    );
    expect(body).toContain('<p>본문<sup>1</sup></p><p><sup>1</sup> 얼음에서 녹임</p>');
  });

  it('prints a footnote kept with a method step under that step', () => {
    const body = worksheetBody((md) => md.replace('#### Method\n- (method used in this step)', ['#### Method', '1. 시작[^a]', '[^a]: 37 °C'].join('\n')));
    expect(body).toContain('<ul class="sub"><li><sup>a</sup> 37 °C</li></ul>');
  });

  it('prints math it cannot read as written, in italics', () => {
    const body = worksheetBody((md) =>
      md.replace(
        '#### Results & Discussions\n- (Any results and discussions. Link file path if needed)',
        '#### Results & Discussions\n$\\sqrt{2}$ 와 $\\frac{1}{2}$',
      ),
    );
    expect(body).toContain('<p><i>\\sqrt{2}</i> 와 1/2</p>');
  });

  it("prints a table cell's formatting like the text around it", () => {
    const body = worksheetBody((md) =>
      md.replace('#### Equipment\n- (e.g. centrifuge, spectrophotometer, etc.)', '#### Equipment\n| 장비 | 비고 |\n| --- | --- |\n| **원심기** | *4 °C* ~~5 °C~~ |'),
    );
    expect(body).toContain('<td>원심기</td><td><i>4 °C</i> <s>5 °C</s></td>');
  });
});

describe('noteTitleOf', () => {
  it('reads the front-matter title, else the file name without .labnote', () => {
    expect(noteTitleOf('e/01_x.labnote.md', '---\ntitle: "  My note "\n---\nbody')).toBe('My note');
    expect(noteTitleOf('e/01_x.labnote.md', '---\nauthor: a\n---\n')).toBe('01_x');
    expect(noteTitleOf('README.md', 'no front matter')).toBe('README');
  });
});

describe('printWorksheetCommand', () => {
  const PATH = 'e/01_wd.labnote.md';
  const ID = 'LN-7K3M9QX2';

  interface Harness {
    deps: WorksheetDeps;
    files: Map<string, string>;
    notes: Array<{ kind: NotifyKind; message: string }>;
    events: string[];
    printed: Array<{ pages: PrintPage[]; paper: WorksheetPaperSize }>;
    opened: Array<{ kind: string; noteId: string; html: string }>;
    reads: () => number;
  }

  function harness(
    content: string,
    opts: { choice?: WorksheetChoice; paper?: WorksheetPaperSize; print?: () => Promise<void>; sampleLookup?: WorksheetDeps['sampleLookup'] } = {},
  ): Harness {
    const files = new Map([[PATH, content]]);
    const notes: Harness['notes'] = [];
    const events: string[] = [];
    const printed: Harness['printed'] = [];
    const opened: Harness['opened'] = [];
    let reads = 0;
    let paper: WorksheetPaperSize = opts.paper ?? 'a4';
    const host = { notify: (kind: NotifyKind, message: string) => notes.push({ kind, message }) } as unknown as AppHost;
    const deps: WorksheetDeps = {
      host,
      t: coreT,
      read: async (p) => {
        reads++;
        return files.get(p)!;
      },
      paper: () => paper,
      setPaper: async (p) => {
        await Promise.resolve();
        paper = p;
        events.push(`setPaper:${p}`);
      },
      ensureNoteId: async (p) => {
        events.push('ensureNoteId');
        files.set(p, files.get(p)!.replace(/^---\n/, `---\nlabnote_id: ${ID}\n`));
        return ID;
      },
      sampleLookup: opts.sampleLookup,
      choose: async (unitOps, p) => {
        events.push(`choose:${unitOps.map((u) => u.index).join(',')}:${p}`);
        return opts.choice;
      },
      print: async (pages, p) => {
        events.push(`print:${p}`);
        if (opts.print) await opts.print();
        printed.push({ pages, paper: p });
      },
      openInBrowser: async (kind, noteId, html) => {
        events.push(`open:${kind}`);
        opened.push({ kind, noteId, html });
      },
    };
    return { deps, files, notes, events, printed, opened, reads: () => reads };
  }

  const threeOps = () => noteWith([hw('UHW010', 'PCR'), sw('USW020'), hw('UHW030', 'Gel')]);

  it('a note with no unit operations gives the plugin notice and prints nothing', async () => {
    const h = harness(noteWith([]), { choice: { indices: [1], paper: 'a4', target: 'print' } });
    await printWorksheetCommand(h.deps, PATH);
    expect(h.notes).toEqual([
      { kind: 'info', message: coreT('This note has no unit operations to print. Add one with "{0}" first.', coreT('Insert unit operation')) },
    ]);
    expect(h.events).toEqual([]);
  });

  it('cancel in the dialog assigns no ID and prints nothing', async () => {
    const before = threeOps();
    const h = harness(before);
    await printWorksheetCommand(h.deps, PATH);
    expect(h.events).toEqual(['choose:1,2,3:a4']);
    expect(h.files.get(PATH)).toBe(before);
    expect(h.printed).toEqual([]);
    expect(h.opened).toEqual([]);
    expect(h.notes).toEqual([]);
  });

  it('assigns the ID, re-reads the note and prints only the chosen unit ops', async () => {
    const h = harness(threeOps(), { choice: { indices: [2], paper: 'a4', target: 'print' } });
    await printWorksheetCommand(h.deps, PATH);
    expect(h.events).toEqual(['choose:1,2,3:a4', 'ensureNoteId', 'print:a4']);
    expect(h.reads()).toBe(2);
    expect(h.printed).toHaveLength(1);
    const pages = h.printed[0].pages;
    expect(pages.length).toBeGreaterThan(0);
    for (const p of pages) expect(decodeScanPayload(p.payload)).toMatchObject({ noteId: ID, unitOpIndex: 2, opId: 'USW020' });
    expect(h.opened).toEqual([]);
  });

  it('a changed paper size is saved before printing', async () => {
    const h = harness(threeOps(), { paper: 'a4', choice: { indices: [1], paper: 'letter', target: 'print' } });
    await printWorksheetCommand(h.deps, PATH);
    expect(h.events).toEqual(['choose:1,2,3:a4', 'setPaper:letter', 'ensureNoteId', 'print:letter']);
    expect(h.printed[0].paper).toBe('letter');
  });

  it('an unchanged paper size is not saved again', async () => {
    const h = harness(threeOps(), { paper: 'letter', choice: { indices: [1], paper: 'letter', target: 'print' } });
    await printWorksheetCommand(h.deps, PATH);
    expect(h.events.some((e) => e.startsWith('setPaper'))).toBe(false);
  });

  it('browser target opens <noteId>_worksheet.html and notifies', async () => {
    const h = harness(threeOps(), { choice: { indices: [1, 3], paper: 'a4', target: 'browser' } });
    await printWorksheetCommand(h.deps, PATH);
    expect(h.events).toEqual(['choose:1,2,3:a4', 'ensureNoteId', 'open:worksheet']);
    expect(h.opened).toHaveLength(1);
    expect(h.opened[0].noteId).toBe(ID);
    const html = h.opened[0].html;
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain(`<script>${FIT_SCRIPT}</script>`);
    expect(html).toContain(`<title>${escapeHtml(titleOf(h.files.get(PATH)!))} — ${coreT('Experiment worksheet')}</title>`);
    expect(html).toContain('<section class="page a4">');
    expect(h.notes).toEqual([{ kind: 'info', message: coreT('Opened the worksheet in your browser. Print it from there.') }]);
  });

  it('a failing print falls back to the browser with the app notice', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = harness(threeOps(), {
      choice: { indices: [1], paper: 'letter', target: 'print' },
      print: async () => {
        throw new Error('no printer');
      },
    });
    await printWorksheetCommand(h.deps, PATH);
    expect(h.events).toEqual(['choose:1,2,3:a4', 'setPaper:letter', 'ensureNoteId', 'print:letter', 'open:worksheet']);
    expect(h.opened[0]).toMatchObject({ kind: 'worksheet', noteId: ID });
    expect(h.opened[0].html).toContain('<section class="page letter">');
    expect(h.notes).toEqual([{ kind: 'info', message: overrideOr('print.openedInBrowser') }]);
    warn.mockRestore();
  });

  it('no ID (unreadable front matter or a cancelled offer) prints nothing', async () => {
    const h = harness(threeOps(), { choice: { indices: [1], paper: 'a4', target: 'print' } });
    h.deps.ensureNoteId = async () => undefined;
    await printWorksheetCommand(h.deps, PATH);
    expect(h.printed).toEqual([]);
    expect(h.opened).toEqual([]);
  });

  it('sample locations are annotated only when the note tracks samples', async () => {
    const md = threeOps().replace('#### Method\n- (method used in this step)', '#### Method\n1. Thaw DNA-1 on ice');
    const lookup = (type: string, id: string) => (type === 'DNA' && id.toLowerCase() === 'dna-1' ? 'Freezer A/1' : undefined);
    const tracked = harness(md, {
      choice: { indices: [1], paper: 'a4', target: 'print' },
      sampleLookup: async (p) => (p === PATH ? { types: ['DNA'], lookup } : undefined),
    });
    await printWorksheetCommand(tracked.deps, PATH);
    expect(tracked.printed[0].pages.map((p) => p.body).join('')).toContain('Thaw DNA-1 on ice — Freezer A/1');

    const untracked = harness(md, { choice: { indices: [1], paper: 'a4', target: 'print' }, sampleLookup: async () => undefined });
    await printWorksheetCommand(untracked.deps, PATH);
    const body = untracked.printed[0].pages.map((p) => p.body).join('');
    expect(body).toContain('Thaw DNA-1 on ice');
    expect(body).not.toContain('Freezer A/1');
  });
});

/** The title noteTitleOf gives the test note (createWorkflowContent writes one). */
function titleOf(content: string): string {
  return noteTitleOf('e/01_wd.labnote.md', content);
}
