// Ported from app/vendor/labnoteo/src/print/worksheetPrint.ts:36-275 sha256:11a5fa3390222c04
// Ported from app/vendor/labnoteo/src/print/worksheetPrint.ts:277-309 sha256:e67f7c72709416dd
// Ported from app/vendor/labnoteo/src/print/worksheetPrint.ts:311-392 sha256:33186b389d8ed716
// labnoteO 0.140.2, Apache-2.0.
// Changes: inline and blocksHtml are exported (the whole-note print reuses them); buildWorksheetHtml is gone: the pages are worksheetPrintPages(paginateWorksheet(...)) and go to deps.print (print/printRoot.ts printPages) or, as a standalone file built from the sanitized tree (print/openInBrowser.ts standaloneFromPages), to deps.openInBrowser('worksheet', noteId, html); noteTitleOf(app, file) becomes noteTitleOf(path, content), reading the front-matter title through core parseFrontMatterYaml; WorksheetDeps swaps app and TFile for a path and read(path), and gains choose (the dialog), print and openInBrowser; WorksheetModal becomes the React print/WorksheetDialog.tsx behind deps.choose, so WorksheetChoice is exported here, with unitOpLabel for its rows; 'Printing from Obsidian did not work…' becomes overrideOr('print.openedInBrowser'). The footer's scan-folder sentence stays the plugin key (Part B adds the scan folder).
/**
 * "Print experiment worksheet": the unit operations of a workflow note as
 * pages to carry into the lab, each with a QR code naming the note, the unit
 * operation and the page, so a photo of it can be filed back automatically.
 */
import { parseFrontMatterYaml, type Translator } from '@labnoteo/core';
import { getSeoulDateString } from '@labnoteo/core/lib/dateUtils';
import { encodePagePayload, payloadLabel, unitOpFingerprint, type PagePayload } from '@labnoteo/core/lib/scanPayload';
import type { SampleLocationLookup } from '@labnoteo/core/lib/sampleStorage';
import {
  annotateWorksheetSamples,
  listWorksheetUnitOps,
  paginateWorksheet,
  type WorksheetPage,
  type WorksheetBlock,
  type WorksheetQuote,
  type WorksheetSection,
  type WorksheetUnitOp,
} from '@labnoteo/core/lib/worksheet';
import {
  CODE_SPAN_RE,
  EM_STAR_RE,
  EM_UNDERSCORE_RE,
  ESCAPED_MARK_RE,
  FOOTNOTE_REF_RE,
  HIGHLIGHT_RE,
  MATH_BLOCK_RE,
  MATH_INLINE_RE,
  codeSpanText,
} from '@labnoteo/core/lib/exportTablesCsv';
import type { WorksheetPaperSize } from '../../../vendor/labnoteo/src/settings';
import type { AppHost } from '../host/createAppHost';
import { overrideOr } from '../i18n';
import { standaloneFromPages } from '../print/openInBrowser';
import { escapeHtml, type PrintPage } from './printPages';
import { texToHtml } from './texHtml';

/** Markdown inline syntax reduced to its text: links, emphasis, code ticks. */
export function plainInline(text: string): string {
  return text
    .replace(/!\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g, '[$1]')
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/`([^`]+)`/g, '$1');
}

/**
 * A formula as printable text, or italic TeX when it uses more than
 * {@link texToHtml} reads: printing it as written beats printing it wrong.
 */
const mathHtml = (tex: string): string => {
  const read = texToHtml(tex);
  return read === undefined ? `<i>${escapeHtml(tex)}</i>` : read;
};

/**
 * A footnote definition as the raised number its references print as (#434):
 * `[^1]: thawed on ice` becomes `¹ thawed on ice`. Run before `inline()`,
 * which keeps `<sup>` but escapes everything around it.
 */
export const footnoteDefinitionMarked = (text: string): string =>
  text.replace(/^\[\^([^\]\s]+)\]:[ \t]*/, '<sup>$1</sup> ');

/**
 * Inline Markdown as the reading view shows it, escaped for HTML (#434): code
 * as written and math as printable text, `<sub>`/`<sup>` and HTML entities
 * kept, struck-through text struck rather than dropped (a crossed-out value
 * must not read as a live one), a highlight underlined for black-and-white
 * printing and a footnote reference as its raised number.
 */
export function inline(text: string): string {
  const held: string[] = [];
  const hold = (html: string): string => `\u0000${held.push(html) - 1}\u0000`;
  let s = text
    .replace(CODE_SPAN_RE, (_m, _ticks: string, body: string) => hold(escapeHtml(codeSpanText(body))))
    .replace(MATH_BLOCK_RE, (_m, tex: string) => hold(mathHtml(tex)))
    .replace(MATH_INLINE_RE, (_m, before: string, tex: string) => before + hold(mathHtml(tex)))
    .replace(ESCAPED_MARK_RE, (_m, mark: string) => hold(escapeHtml(mark)))
    .replace(/<(sub|sup)>([\s\S]*?)<\/\1>/gi, (_m, tag: string, body: string) => {
      const name = tag.toLowerCase();
      return `${hold(`<${name}>`)}${body}${hold(`</${name}>`)}`;
    });
  s = escapeHtml(plainInline(s))
    .replace(/&amp;([a-z][a-z\d]*|#\d+|#x[\da-f]+);/gi, '&$1;')
    .replace(EM_STAR_RE, '$1<i>$2</i>')
    .replace(EM_UNDERSCORE_RE, '$1<i>$2</i>')
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<s>$1</s>')
    .replace(HIGHLIGHT_RE, '<mark>$1</mark>')
    .replace(FOOTNOTE_REF_RE, '<sup>$1</sup>');
  return s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => held[Number(i)]);
}

const codeHtml = (lines: readonly string[]): string => `<pre class="code">${escapeHtml(lines.join('\n'))}</pre>`;

/**
 * A callout as a bordered box under its type and title, a plain quote with a
 * rule on its left (#558): printed as `> [!warning]` it read as markup.
 */
function quoteHtml(quote: WorksheetQuote): string {
  const body = quote.lines.map(l => `<div>${inline(l) || '&nbsp;'}</div>`).join('');
  if (!quote.callout) return `<blockquote class="quote">${body}</blockquote>`;
  const label = quote.callout.charAt(0).toUpperCase() + quote.callout.slice(1);
  const title = quote.title ? ` ${inline(quote.title)}` : '';
  return `<div class="callout"><div class="callout-title"><b>${escapeHtml(label)}</b>${title}</div>${body}</div>`;
}

/** A pipe table as a printed table: on paper its `|` marks would be unreadable (#254). */
function tableHtml(rows: readonly string[][]): string {
  const [header, ...body] = rows;
  const cells = (row: readonly string[], tag: 'th' | 'td'): string =>
    row.map(c => `<${tag}>${inline(c)}</${tag}>`).join('');
  const head = header ? `<tr>${cells(header, 'th')}</tr>` : '';
  return `<table class="grid">${head}${body.map(r => `<tr>${cells(r, 'td')}</tr>`).join('')}</table>`;
}

/**
 * Section blocks as paper would have them: a list prints with bullets rather
 * than its `- ` marks (#253), a run of items staying one list.
 */
export function blocksHtml(blocks: readonly WorksheetBlock[]): string {
  let html = '';
  let items: string[] = [];
  const flush = (): void => {
    if (items.length === 0) return;
    html += `<ul class="bul">${items.join('')}</ul>`;
    items = [];
  };
  for (const block of blocks) {
    if (block.kind === 'item') {
      items.push(`<li class="d${Math.min(block.level, 3)}">${inline(block.text) || '&nbsp;'}</li>`);
      continue;
    }
    flush();
    html +=
      block.kind === 'table'
        ? tableHtml(block.rows)
        : block.kind === 'code'
          ? codeHtml(block.lines)
          : block.kind === 'quote'
            ? quoteHtml(block)
            : `<p>${inline(block.footnote ? footnoteDefinitionMarked(block.text) : block.text) || '&nbsp;'}</p>`;
  }
  flush();
  return html;
}

/** The sections that get twice the leftover height: the ones written in by hand the most. */
const WIDE_SECTIONS = new Set(['Method', 'Results & Discussions']);

/**
 * How much of the page's leftover height a section takes, in shares (#245).
 * A section with nothing in it is there to be written in, and Results &
 * Discussions keeps room under what is already written.
 */
function growShares(section: WorksheetSection): number {
  if (section.type === 'blank') return WIDE_SECTIONS.has(section.title) ? 2 : 1;
  if (section.type === 'text' && section.title === 'Results & Discussions') return 2;
  return 0;
}

function sectionHtml(section: WorksheetSection): string {
  // The text written above the first `####` has no heading of its own (#383).
  const title = section.title ? `<h3>${escapeHtml(section.title)}</h3>` : '';
  const grow = growShares(section);
  const growClass = grow > 0 ? ` g${grow}` : '';
  const fill = grow > 0 ? '<div class="fill"></div>' : '';
  switch (section.type) {
    case 'meta': {
      const rows = section.fields
        .map(f => `<tr><td class="k">${escapeHtml(f.label)}</td><td class="v">${inline(f.value)}&nbsp;</td></tr>`)
        .join('');
      return `<div class="sec">${title}<table class="meta">${rows}</table></div>`;
    }
    case 'steps': {
      // What precedes the first step gets no box or number, so step 1 is the note's step 1.
      let n = 0;
      const items = section.steps
        .map(s => {
          // A footnote the parser kept with its step prints under it (#418), as
          // the raised number a reference in that step shows (#434).
          const sub =
            s.sub.length > 0
              ? `<ul class="sub">${s.sub.map(l => `<li>${inline(footnoteDefinitionMarked(l))}</li>`).join('')}</ul>`
              : '';
          const mark = s.preface ? '' : `<span class="box${s.done ? ' done' : ''}"></span><span class="n">${++n}.</span>`;
          return (
            `<li>${mark}<div class="s">${inline(s.text)}${sub}${s.table ? tableHtml(s.table) : ''}` +
            `${(s.code ?? []).map(codeHtml).join('')}${(s.quotes ?? []).map(quoteHtml).join('')}</div></li>`
          );
        })
        .join('');
      return `<div class="sec">${title}<ol class="steps">${items}</ol></div>`;
    }
    case 'text':
      return `<div class="sec text${growClass}">${title}${blocksHtml(section.blocks)}${fill}</div>`;
    case 'blank':
      return `<div class="sec${growClass}">${title}${fill}</div>`;
  }
}

export interface WorksheetContext {
  noteTitle: string;
  noteId: string;
  printedOn: string;
  t: Translator;
}

function unitOpTitle(op: WorksheetUnitOp): string {
  return `[${op.opId} ${op.opName}]${op.alias ? ` ${op.alias}` : ''}`;
}

/** The printable form of worksheet pages. */
export function worksheetPrintPages(pages: readonly WorksheetPage[], ctx: WorksheetContext): PrintPage[] {
  return pages.map(p => {
    const payload: PagePayload = {
      noteId: ctx.noteId,
      unitOpIndex: p.unitOp.index,
      opId: p.unitOp.opId,
      fingerprint: unitOpFingerprint(p.unitOp.opName, p.unitOp.alias),
      page: p.page,
      pageCount: p.pageCount,
      printedOn: ctx.printedOn,
    };
    const continued = p.page > 1 ? ` <span class="muted">(${escapeHtml(ctx.t('continued'))})</span>` : '';
    const header =
      `<div class="muted">${escapeHtml(ctx.noteTitle)} · ${escapeHtml(ctx.noteId)}</div>` +
      `<div class="title">${inline(unitOpTitle(p.unitOp))}${continued}</div>` +
      (p.page === 1 && p.unitOp.description ? `<div>${inline(p.unitOp.description)}</div>` : '') +
      `<div class="muted">${escapeHtml(ctx.t('Page {0} of {1} · printed {2}', String(p.page), String(p.pageCount), ctx.printedOn))}</div>`;
    return {
      payload: encodePagePayload(payload),
      label: payloadLabel(payload),
      header,
      body: `<div class="ws">${p.sections.map(sectionHtml).join('')}</div>`,
      footer: escapeHtml(
        ctx.t('Write on this sheet, then photograph or scan it with a QR code visible and put the file in the scan folder.')
      ),
    };
  });
}

/** The note's front-matter title, else its file name without `.labnote`. */
export function noteTitleOf(path: string, content: string): string {
  const title: unknown = parseFrontMatterYaml(content.replace(/\r\n/g, '\n')).frontMatter.title;
  const name = path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/i, '');
  return typeof title === 'string' && title.trim() ? title.trim() : name.replace(/\.labnote$/, '');
}

export interface WorksheetDeps {
  host: AppHost;
  t: Translator;
  /** The note's text (the open buffer for an open note). */
  read(path: string): Promise<string>;
  paper(): WorksheetPaperSize;
  setPaper(paper: WorksheetPaperSize): Promise<void>;
  ensureNoteId(path: string): Promise<string | undefined>;
  /** Sample types and where their samples are stored, for the note (#496); undefined when it does not track samples. */
  sampleLookup?(path: string): Promise<{ types: string[]; lookup: SampleLocationLookup } | undefined>;
  /** The worksheet dialog: the unit operations to print, the paper and where; undefined when it was closed. */
  choose(unitOps: readonly WorksheetUnitOp[], paper: WorksheetPaperSize): Promise<WorksheetChoice | undefined>;
  /** Print in the app (print/printRoot.ts printPages); throws when printing did not work. */
  print(pages: PrintPage[], paper: WorksheetPaperSize): Promise<void>;
  /** Hand a standalone file to Rust, which writes `<noteId>_<kind>.html` and opens it in the default browser. */
  openInBrowser(kind: 'worksheet' | 'note', noteId: string, html: string): Promise<void>;
}

/**
 * The unit operations to print selected at first: the lab ones, or every one
 * of a note with only software ones (#508), whose run log is worth printing too.
 */
export function initialWorksheetSelection(unitOps: readonly WorksheetUnitOp[]): number[] {
  const lab = unitOps.filter(op => op.kind === 'hw');
  return (lab.length > 0 ? lab : unitOps).map(op => op.index);
}

/** A worksheet has no images: nothing to read back into the standalone file. */
const noImages = async (): Promise<Blob | undefined> => undefined;

/** Pick the unit operations to print (lab ones preselected), then print or open in a browser. */
export async function printWorksheetCommand(deps: WorksheetDeps, path: string): Promise<void> {
  const { host } = deps;
  const unitOps = listWorksheetUnitOps(await deps.read(path));
  if (unitOps.length === 0) {
    host.notify('info', deps.t('This note has no unit operations to print. Add one with "{0}" first.', deps.t('Insert unit operation')));
    return;
  }
  const choice = await deps.choose(unitOps, deps.paper());
  if (!choice) return;
  if (choice.paper !== deps.paper()) await deps.setPaper(choice.paper);
  const noteId = await deps.ensureNoteId(path);
  if (!noteId) return;
  // Re-read: assigning the ID rewrote the note, and it may have been edited meanwhile.
  const content = await deps.read(path);
  const chosen = listWorksheetUnitOps(content).filter(op => choice.indices.includes(op.index));
  const samples = await deps.sampleLookup?.(path);
  const fresh = samples ? annotateWorksheetSamples(chosen, samples.types, samples.lookup) : chosen;
  const noteTitle = noteTitleOf(path, content);
  const pages = worksheetPrintPages(paginateWorksheet(fresh), { noteTitle, noteId, printedOn: getSeoulDateString(), t: deps.t });
  const title = `${noteTitle} — ${deps.t('Experiment worksheet')}`;
  const openInBrowser = async (): Promise<void> =>
    deps.openInBrowser('worksheet', noteId, await standaloneFromPages(title, choice.paper, pages, noImages));
  if (choice.target === 'browser') {
    await openInBrowser();
    host.notify('info', deps.t('Opened the worksheet in your browser. Print it from there.'));
    return;
  }
  try {
    await deps.print(pages, choice.paper);
  } catch (err) {
    console.warn('[labnoteo] printing in the app failed, opening in the browser:', err);
    await openInBrowser();
    // The plugin's 'Printing from Obsidian did not work, so the worksheet opened in your browser. Print it from there.'
    host.notify('info', overrideOr('print.openedInBrowser'));
  }
}

/** What the worksheet dialog answers. */
export interface WorksheetChoice {
  indices: number[];
  paper: WorksheetPaperSize;
  target: 'print' | 'browser';
}

/** A unit operation's row in the worksheet dialog: `N. [opId name] alias`. */
export function unitOpLabel(op: WorksheetUnitOp): string {
  return `${op.index}. ${unitOpTitle(op)}`;
}
