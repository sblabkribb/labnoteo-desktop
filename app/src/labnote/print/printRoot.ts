/**
 * 인쇄 루트: 본 웹뷰의 <body> 아래 `#labnote-print-root.print-root` 하나(A2). iframe 도, 인라인 <style>·<script> 도,
 * .style 쓰기도 없다. 페이지 HTML 은 DOMParser 가 만든 문서(스크립트·이미지가 돌지 않는다)에서 sanitizePrintTree 로
 * 정리한 다음에야 이 루트로 옮겨진다. 모양은 print.css(화면에서는 보이지 않는 곳에 놓여 측정만 되고, 인쇄할 때
 * body.printing-pages 이면 앱을 숨기고 이 루트만 찍는다).
 */
import './print.css';
import type { WorksheetPaperSize } from '../../../vendor/labnoteo/src/settings';
import { fitBodies, MIN_SCALE, pagesHtml, type PrintPage } from '../port/printPages';
import { sanitizePrintTree } from './sanitize';

const ROOT_ID = 'labnote-print-root';
const PRINTING = 'printing-pages';
/** 글꼴·이미지 하나를 기다리는 최대 시간(플러그인 waitForImages 와 같다). */
const WAIT_MS = 5000;

/** 인쇄 루트. 없으면 한 번 만든다. */
export function printRoot(doc: Document = document): HTMLElement {
  const found = doc.getElementById(ROOT_ID);
  if (found) return found;
  const root = doc.createElement('div');
  root.id = ROOT_ID;
  root.className = 'print-root';
  doc.body.appendChild(root);
  return root;
}

/** `html` 을 비활성 문서에서 파싱·정화한 다음 인쇄 루트의 내용으로 바꿔 넣는다(이전 작업의 내용은 사라진다). */
export function mountPages(html: string, doc: Document = document): HTMLElement {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  sanitizePrintTree(parsed.body);
  const root = printRoot(doc);
  root.replaceChildren(...Array.from(parsed.body.childNodes).map((n) => doc.adoptNode(n)));
  return root;
}

function delay(win: Window, ms: number): Promise<void> {
  return new Promise((resolve) => win.setTimeout(resolve, ms));
}

async function waitForFonts(doc: Document, win: Window, ms: number): Promise<void> {
  const ready = (doc as Document & { fonts?: { ready?: Promise<unknown> } }).fonts?.ready;
  if (!ready) return;
  await Promise.race([ready.then(() => undefined, () => undefined), delay(win, ms)]);
}

async function waitForImages(root: ParentNode, win: Window, ms: number): Promise<void> {
  await Promise.all(
    Array.from(root.querySelectorAll('img'))
      .filter((img) => !img.complete)
      .map(
        (img) =>
          new Promise<void>((resolve) => {
            img.addEventListener('load', () => resolve(), { once: true });
            img.addEventListener('error', () => resolve(), { once: true });
            win.setTimeout(resolve, ms);
          }),
      ),
  );
}

/** 글꼴과 `root` 아래 이미지를 기다린다(각 `waitMs` 까지). 노트 전체 인쇄가 재기 전에도 쓴다. */
export async function settle(root: ParentNode, doc: Document = document, waitMs: number = WAIT_MS): Promise<void> {
  const win = doc.defaultView ?? window;
  await waitForFonts(doc, win, waitMs);
  await waitForImages(root, win, waitMs);
}

/** 지금 인쇄 루트를 쓰는 작업. 새 작업이 시작되면 앞 작업의 afterprint 는 아무것도 치우지 않는다. */
let currentJob = 0;

/**
 * `pages` 를 인쇄 루트에 올리고 인쇄한다: body 에 printing-pages 를 붙이고, 글꼴과 이미지를 기다리고(각 5 초까지),
 * fitBodies 로 글자를 줄인 다음 `print`(기본 window.print)를 부른다. afterprint 에 루트를 비우고 클래스를 뗀다.
 * print 가 던지면(또는 그 앞에서 실패하면) 같은 정리를 하고 다시 던진다: 부르는 쪽이 브라우저로 여는 길로 간다(A3).
 */
export async function printPages(
  pages: readonly PrintPage[],
  paper: WorksheetPaperSize,
  deps: { print?: () => void; doc?: Document; waitMs?: number } = {},
): Promise<void> {
  const doc = deps.doc ?? document;
  const win = doc.defaultView ?? window;
  const waitMs = deps.waitMs ?? WAIT_MS;
  const job = ++currentJob;
  const cleanup = (): void => {
    win.removeEventListener('afterprint', cleanup);
    if (job !== currentJob) return;
    printRoot(doc).replaceChildren();
    doc.body.classList.remove(PRINTING);
  };
  try {
    const root = mountPages(pagesHtml(pages, paper), doc);
    doc.body.classList.add(PRINTING);
    await settle(root, doc, waitMs);
    if (job !== currentJob) return; // 기다리는 사이 새 작업이 루트를 가져갔다
    fitBodies(root, MIN_SCALE);
    win.addEventListener('afterprint', cleanup);
    (deps.print ?? (() => win.print()))();
  } catch (e) {
    cleanup();
    throw e;
  }
}
