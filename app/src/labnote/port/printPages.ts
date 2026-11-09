// Ported from app/vendor/labnoteo/src/print/printPages.ts:14-158 sha256:9a7718806550580e
// labnoteO 0.140.2, Apache-2.0.
// Changes: pageCss became the static print/print.css (named pages a4/letter, a grid page whose header pushes the body down), so it is not exported; fitBodies(doc) became fitBodies(root) and shrinks the type by toggling the classes fit-95…fit-70 instead of writing el.style, and drops the header-overlap code (the grid replaces it); buildPrintHtml became pagesHtml (the page sections, marked with the paper class) plus buildStandaloneHtml over the sanitized tree (the print.css text via '?raw' in print/openInBrowser.ts, one CSP meta, and FIT_SCRIPT, a hand-written copy of the class-based fitBodies pinned by FIT_SCRIPT_SHA256); MIN_SCALE is exported; printHtml, waitForImages and openHtmlInBrowser (iframe, Electron) are replaced by print/printRoot.ts and Task 7.
/**
 * Printable pages with a QR code in two corners (top right, bottom left), so
 * a photo still shows one when a hand or a fold covers the other.
 *
 * Markdown has no pages, so the pages are laid out here as fixed-size boxes
 * and printed from a sanitized print root in the main webview (print/printRoot.ts)
 * under print/print.css. Every piece of note text must go through {@link escapeHtml}.
 */
import type { WorksheetPaperSize } from '../../../vendor/labnoteo/src/settings';
import { qrSvg } from './qr';

export interface PrintPage {
  /** QR text (see `scanPayload`). */
  payload: string;
  /** The line under each QR for people. */
  label: string;
  /** Header HTML (already escaped). */
  header: string;
  /** Body HTML (already escaped). */
  body: string;
  /** Footer HTML (already escaped). */
  footer: string;
}

export const PAPER_MM: Record<WorksheetPaperSize, { width: number; height: number }> = {
  a4: { width: 210, height: 297 },
  letter: { width: 215.9, height: 279.4 },
};

/** Distance of the QR codes from the paper edge: clear of what printers cannot reach (print.css uses the same). */
const QR_INSET_MM = 10;
/** Printed QR size; 2.5 cm or more stays readable in a phone photo of the whole page (print.css uses the same). */
const QR_SIZE_MM = 26;
/** Smallest type the body shrinks to when it does not fit the page. */
export const MIN_SCALE = 0.7;

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}

/** The body area of a page, in mm: what the full-note layout measures against. */
export function bodyBox(paper: WorksheetPaperSize): { width: number; height: number; top: number; left: number } {
  const { width, height } = PAPER_MM[paper];
  const top = QR_INSET_MM + QR_SIZE_MM + 8;
  const bottom = QR_INSET_MM + QR_SIZE_MM + 6;
  const side = 14;
  return { width: width - side * 2, height: height - top - bottom, top, left: side };
}

/**
 * Shrink each page body's type until it fits, down to `minScale`, by class
 * (`.body.fit-95` … `.body.fit-70` in print.css): no style is written. It
 * references nothing outside itself, so its source can become the standalone
 * file's fit script (Task 7).
 */
export function fitBodies(root: ParentNode, minScale: number): void {
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('.body'))) {
    for (const c of Array.from(el.classList)) if (/^fit-\d+$/.test(c)) el.classList.remove(c);
    let scale = 1;
    let applied = '';
    while (el.scrollHeight > el.clientHeight + 1 && scale > minScale) {
      scale = Math.round((scale - 0.05) * 100) / 100;
      if (applied) el.classList.remove(applied);
      applied = 'fit-' + Math.round(scale * 100);
      el.classList.add(applied);
    }
  }
}

/** The `<section class="page a4|letter">` list for `pages`. It enters the DOM only through print/printRoot.ts `mountPages`. */
export function pagesHtml(pages: readonly PrintPage[], paper: WorksheetPaperSize): string {
  return pages
    .map(p => {
      const qr = qrSvg(p.payload, p.label);
      const label = `<div class="label">${escapeHtml(p.label)}</div>`;
      return (
        `<section class="page ${paper}">` +
        `<div class="qr tr">${qr}${label}</div>` +
        `<header class="head">${p.header}</header>` +
        `<main class="body">${p.body}</main>` +
        `<footer class="foot">${p.footer}</footer>` +
        `<div class="qr bl">${qr}${label}</div>` +
        '</section>'
      );
    })
    .join('\n');
}

/**
 * The standalone file's only script: {@link fitBodies} with {@link MIN_SCALE}, run on `load`, written out by hand
 * (a bundler's `Function.toString` would change with the build and break the pinned hash). It is a constant of
 * the app, never note text.
 */
export const FIT_SCRIPT =
  "window.addEventListener('load',function(){document.querySelectorAll('.body').forEach(function(el){" +
  "Array.prototype.slice.call(el.classList).forEach(function(c){if(/^fit-[0-9]+$/.test(c))el.classList.remove(c);});" +
  "var s=1,a='';while(el.scrollHeight>el.clientHeight+1&&s>0.7){s=Math.round((s-0.05)*100)/100;" +
  "if(a)el.classList.remove(a);a='fit-'+Math.round(s*100);el.classList.add(a);}});});";

/** Base64 SHA-256 of {@link FIT_SCRIPT}, for the standalone file's CSP `script-src`. A test recomputes it. */
export const FIT_SCRIPT_SHA256 = '2HdwHThfYFV1zCVwaTNLnG05jNj0abjqTSCGhPGa7As=';

/**
 * The file "Open in browser" writes: one CSP meta (no network, images only from `data:`, inline styles, and only
 * the hashed fit script), the app's print CSS, and the pages read back from `root`, a tree that has already been
 * through `sanitizePrintTree`. `paper` is carried by the page sections' class; `title` is escaped.
 */
export function buildStandaloneHtml(title: string, paper: WorksheetPaperSize, root: Element, css: string): string {
  void paper; // the sections already carry `page a4|letter`, which selects the named @page
  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'sha256-${FIT_SCRIPT_SHA256}'">` +
    `<title>${escapeHtml(title)}</title><style>${css}</style></head>` +
    `<body class="printing-pages"><div class="print-root">${root.innerHTML}</div><script>${FIT_SCRIPT}</script></body></html>`
  );
}
