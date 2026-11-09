/**
 * 노트 전체 인쇄의 쪽 나누기 재기(계획 Task 10, 플러그인 fullNotePrint 의 화면 밖 div 의 앱판).
 * 블록마다 DOMParser 로 파싱해 sanitizePrintTree 로 정리하고, 인쇄 루트 안의 `.print-measure.<paper>` 요소
 * (print.css 가 쪽 본문 너비, 10pt / 1.5 로 둔다)에 블록마다 감싼 div 하나로 놓는다. 글꼴과 이미지를 기다린 다음
 * offsetTop/offsetHeight 를 재고, 맨 위 `h3` 의 글로 단위 공정을 알아본 뒤 요소를 뗀다. .style 쓰기는 없다.
 */
import type { WorksheetPaperSize } from '../../../vendor/labnoteo/src/settings';
import { unitOpOfRenderedHeading, type MeasuredBlock } from '../port/fullNotePrint';
import { bodyBox } from '../port/printPages';
import { printRoot, settle } from './printRoot';
import { sanitizePrintTree } from './sanitize';

/** CSS 의 1mm 는 96/25.4 px 다. 레이아웃이 없는 곳(테스트)이나 너비를 잴 수 없을 때 쓴다. */
const CSS_PX_PER_MM = 96 / 25.4;

export async function measureNoteBlocks(
  blocks: readonly string[],
  paper: WorksheetPaperSize,
  opts: { doc?: Document; waitMs?: number } = {},
): Promise<{ blocks: MeasuredBlock[]; pxPerMm: number }> {
  const doc = opts.doc ?? document;
  const measure = doc.createElement('div');
  measure.className = `print-measure note-body ${paper}`;
  const parser = new DOMParser();
  const wrappers = blocks.map((html) => {
    const parsed = parser.parseFromString(html, 'text/html');
    sanitizePrintTree(parsed.body);
    const wrapper = doc.createElement('div');
    wrapper.append(...Array.from(parsed.body.childNodes).map((n) => doc.adoptNode(n)));
    return wrapper;
  });
  measure.append(...wrappers);
  printRoot(doc).appendChild(measure);
  try {
    await settle(measure, doc, opts.waitMs);
    const width = measure.getBoundingClientRect().width / bodyBox(paper).width;
    const pxPerMm = Number.isFinite(width) && width > 0 ? width : CSS_PX_PER_MM;
    return {
      pxPerMm,
      blocks: wrappers.map((el) => {
        const heading = el.querySelector(':scope > h3');
        const op = heading ? unitOpOfRenderedHeading(heading.textContent ?? '') : undefined;
        return { top: el.offsetTop, bottom: el.offsetTop + el.offsetHeight, ...op };
      }),
    };
  } finally {
    measure.remove();
  }
}
