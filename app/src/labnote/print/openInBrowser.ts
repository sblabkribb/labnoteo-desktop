/**
 * "브라우저에서 열기"(A3): 인쇄 페이지를 따로 떨어진 HTML 파일 하나로 만들어 Rust(`print_open_in_browser`)에 넘긴다.
 * Rust 는 그것을 %TEMP%/labnoteO-print/ 에 쓰고 기본 브라우저로 연다. 파일은 정화된 나무에서만 만든다:
 * mountPages 와 같은 DOMParser → sanitizePrintTree 를 떨어진 문서에서 돌리고(앱의 인쇄 루트는 건드리지 않는다),
 * blob: 이미지를 data: 로 바꾼 다음 buildStandaloneHtml 로 감싼다. CSP 가 네트워크·다른 스크립트를 막는다.
 */
import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import type { WorksheetPaperSize } from '../../../vendor/labnoteo/src/settings';
import { buildStandaloneHtml, pagesHtml, type PrintPage } from '../port/printPages';
import { mountPages } from './printRoot';
import printCssRaw from './print.css?raw';

type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

/** 파일 하나에 넣는 이미지 바이트의 합계 상한. 넘는 이미지는 이름만 찍힌다. */
const IMAGE_CAP_BYTES = 32 * 1024 * 1024;

/** data: URI 에 넣어도 되는 이미지 형식(속성값에 다른 것이 섞이지 않게 좁게 본다). */
const IMAGE_TYPE = /^image\/[a-z0-9.+-]+$/i;

/** Rust 에 standalone 파일을 넘겨 기본 브라우저로 연다. 돌려받는 것은 파일 이름뿐이다. */
export function openInBrowser(kind: 'worksheet' | 'note', noteId: string, html: string, invoke: InvokeFn = tauriInvoke): Promise<string> {
  return invoke<string>('print_open_in_browser', { kind, noteId, html });
}

function base64Of(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      resolve(url.slice(url.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(blob);
  });
}

/**
 * `root` 아래 blob: 이미지를 data:image/<type>;base64 로 바꾼다. 읽지 못했거나, 이미지가 아니거나, 합계가 `capBytes` 를
 * 넘는 이미지는 alt(이미지 이름) 글 노드가 된다. 이미 data:image/ 인 것은 그대로 둔다.
 */
export async function inlineImages(
  root: ParentNode,
  read: (src: string) => Promise<Blob | undefined>,
  capBytes: number = IMAGE_CAP_BYTES,
): Promise<void> {
  let used = 0;
  for (const img of Array.from(root.querySelectorAll('img'))) {
    const src = img.getAttribute('src') ?? '';
    if (src.startsWith('data:image/')) continue;
    const asText = (): void => {
      img.replaceWith(img.ownerDocument.createTextNode(img.getAttribute('alt') ?? ''));
    };
    if (!src.startsWith('blob:')) {
      asText();
      continue;
    }
    let blob: Blob | undefined;
    try {
      blob = await read(src);
    } catch {
      blob = undefined;
    }
    if (!blob || !IMAGE_TYPE.test(blob.type) || used + blob.size > capBytes) {
      asText();
      continue;
    }
    let data: string;
    try {
      data = await base64Of(blob);
    } catch {
      asText();
      continue;
    }
    used += blob.size;
    img.setAttribute('src', `data:${blob.type.toLowerCase()};base64,${data}`);
  }
}

/** `pages` 의 standalone 파일: 떨어진 문서에서 mountPages(정화) → inlineImages → buildStandaloneHtml(print.css 원문). */
export async function standaloneFromPages(
  title: string,
  paper: WorksheetPaperSize,
  pages: readonly PrintPage[],
  read: (src: string) => Promise<Blob | undefined>,
): Promise<string> {
  const detached = document.implementation.createHTMLDocument('');
  const root = mountPages(pagesHtml(pages, paper), detached);
  await inlineImages(root, read);
  return buildStandaloneHtml(title, paper, root, printCssRaw);
}
