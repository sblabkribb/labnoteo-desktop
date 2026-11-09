/**
 * 노트 전체 인쇄용 Markdown 렌더러(계획 Task 9, A4). 앱에는 인쇄용 Markdown 라이브러리가 없어서, 이식한 작업지
 * 렌더러(`port/worksheetPrint.ts` 의 `inline`, `blocksHtml`)와 core `parseWorksheetBlocks` 로 노트를 블록마다 HTML
 * 문자열 하나로 만든다(페이지 나누기가 블록 단위로 잰다).
 * - 머리말(front matter)은 뗀다. `#`~`######` 제목 줄은 `<hN>`, 코드 울타리 밖의 `---`·`***`·`___` 줄은 `<hr>`.
 * - 이미지 임베드만 있는 문단은 `<p class="img">` 와 임베드마다 `<img>`. `src` 가 없는 임베드는 `[이름]` 이다.
 * - 나머지는 `blocksHtml(parseWorksheetBlocks(...))` 이고, 맨 위 요소 하나가 블록 하나다.
 * - 노트의 글은 모두 `escapeHtml` 을 거친다(`inline`): 노트 안의 생 HTML 은 쓴 그대로 글로 찍힌다. 노트 임베드와
 *   글 속 이미지는 이름으로 찍힌다(E2). 정화기(`sanitizePrintTree`)가 그 위에서 한 번 더 돈다.
 * - `img` 의 `src` 는 `blob:` 이나 `data:image/` 로 시작할 때만 쓰고, 속성 값으로 이스케이프한다.
 */
import { stripFrontMatter } from '@labnoteo/core';
import { parseWorksheetBlocks, type WorksheetBlock } from '@labnoteo/core/lib/worksheet';
import { stepFence, type OpenFence } from '../../../vendor/labnoteo/packages/labnoteo-core/src/sections/sectionEdit';
import { isImageTarget, pickByName, resolveImagePath, splitAltSize } from '../../editor/live/imagePath';
import { escapeHtml } from '../port/printPages';
import { blocksHtml, inline } from '../port/worksheetPrint';

/** 미리 찾아 둔 이미지 URL. `blob:` 이나 `data:image/` 만 돌려준다(그 밖은 렌더러가 버린다). */
export interface NoteImages {
  src(target: string, kind: 'md' | 'wiki'): string | undefined;
}

interface ImageEmbed {
  target: string;
  kind: 'md' | 'wiki';
  name: string;
}

type Segment =
  | { type: 'heading'; level: number; text: string }
  | { type: 'hr' }
  | { type: 'images'; embeds: ImageEmbed[] }
  | { type: 'text'; lines: string[] };

const HEADING_RE = /^(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const RULE_RE = /^ {0,3}(?:-{3,}|\*{3,}|_{3,})[ \t]*$/;
/** `![[대상|크기]]` 와 `![대체 글](대상)`. */
const EMBED_RE = /!\[\[([^\]|]+)(?:\|[^\]]*)?\]\]|!\[([^\]]*)\]\(([^)]*)\)/g;

const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1);

/** Markdown 대상에서 `"제목"` 을 뗀 경로. */
function mdTarget(raw: string): string {
  const t = raw.trim();
  const titled = /^(\S+)\s+"[^"]*"$/.exec(t);
  return titled ? titled[1] : t;
}

/** 한 줄이 이미지 임베드만으로 되어 있으면 그 임베드들, 아니면 null. */
function imageOnlyLine(line: string): ImageEmbed[] | null {
  const embeds: ImageEmbed[] = [];
  let rest = '';
  let last = 0;
  for (const m of line.matchAll(EMBED_RE)) {
    rest += line.slice(last, m.index);
    last = m.index + m[0].length;
    if (m[1] !== undefined) {
      const target = m[1].trim();
      if (!isImageTarget(target)) return null;
      embeds.push({ target, kind: 'wiki', name: target });
    } else {
      const target = mdTarget(m[3]);
      if (!isImageTarget(target)) return null;
      const alt = splitAltSize(m[2]).alt.trim();
      embeds.push({ target, kind: 'md', name: alt || baseName(target) });
    }
  }
  rest += line.slice(last);
  return embeds.length > 0 && rest.trim() === '' ? embeds : null;
}

/** 머리말을 뗀 노트를 제목, 가로줄, 이미지 문단, 그 밖의 줄 묶음으로 나눈다. 코드 울타리 안은 모두 글이다. */
function segments(markdown: string): Segment[] {
  const lines = stripFrontMatter(markdown.replace(/\r\n?/g, '\n')).split('\n');
  const out: Segment[] = [];
  let run: string[] = [];
  const flush = (): void => {
    if (run.some(l => l.trim() !== '')) out.push({ type: 'text', lines: run });
    run = [];
  };
  let fence: OpenFence | null = null;
  let blockStart = true;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const next = stepFence(line, fence);
    if (fence !== null || next !== null) {
      run.push(line);
      blockStart = fence !== null && next === null;
      fence = next;
      continue;
    }
    if (line.trim() === '') {
      run.push(line);
      blockStart = true;
      continue;
    }
    const heading = HEADING_RE.exec(line);
    if (heading) {
      flush();
      out.push({ type: 'heading', level: heading[1].length, text: heading[2] });
      blockStart = true;
      continue;
    }
    if (RULE_RE.test(line)) {
      flush();
      out.push({ type: 'hr' });
      blockStart = true;
      continue;
    }
    if (blockStart) {
      // 문단 하나: 빈 줄, 제목, 가로줄, 코드 울타리 앞까지.
      let end = i;
      while (
        end < lines.length &&
        lines[end].trim() !== '' &&
        !HEADING_RE.test(lines[end]) &&
        !RULE_RE.test(lines[end]) &&
        stepFence(lines[end], null) === null
      ) {
        end++;
      }
      const para = lines.slice(i, end);
      const embeds = para.map(imageOnlyLine);
      if (embeds.every(e => e !== null)) {
        flush();
        out.push({ type: 'images', embeds: embeds.flat() as ImageEmbed[] });
      } else {
        run.push(...para);
      }
      i = end - 1;
      blockStart = false;
      continue;
    }
    run.push(line);
  }
  flush();
  return out;
}

/** 이미지 문단에 든 이미지 임베드(종류와 대상이 같으면 한 번). 노트 임베드와 글 속 임베드는 없다. */
export function imageTargets(markdown: string): Array<{ target: string; kind: 'md' | 'wiki' }> {
  const seen = new Set<string>();
  const out: Array<{ target: string; kind: 'md' | 'wiki' }> = [];
  for (const seg of segments(markdown)) {
    if (seg.type !== 'images') continue;
    for (const { target, kind } of seg.embeds) {
      const key = `${kind}\u0000${target}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ target, kind });
    }
  }
  return out;
}

const usableSrc = (src: string | undefined): src is string => src !== undefined && (src.startsWith('blob:') || src.startsWith('data:image/'));

/**
 * 노트 `notePath` 의 이미지 문단마다 URL 을 미리 찾는다. 편집기와 같은 규칙이다: `resolveImagePath`, 이름만 쓴
 * 위키 대상은 `pickByName`(보관함 이미지 목록 `list()` 는 많아야 한 번 읽는다), 경로 후보는 차례로 `load`.
 * 찾지 못한 대상, 읽기에 실패한 대상, `blob:`/`data:image/` 가 아닌 URL 은 `src` 가 없다.
 */
export async function resolveNoteImages(
  markdown: string,
  notePath: string,
  load: (vaultPath: string) => Promise<string | undefined>,
  list: () => Promise<string[]>,
): Promise<NoteImages> {
  let listed: Promise<string[]> | null = null;
  const paths = (): Promise<string[]> => (listed ??= list().catch(() => []));
  const found = new Map<string, string>();
  for (const { target, kind } of imageTargets(markdown)) {
    const ref = resolveImagePath(notePath, target, kind);
    if (ref === null) continue;
    let candidates: string[];
    if (ref.kind === 'name') {
      const all = await paths();
      const hit = pickByName(notePath, ref.name, all) ?? (ref.fallback === undefined ? null : pickByName(notePath, ref.fallback, all));
      candidates = hit === null ? [] : [hit];
    } else {
      candidates = ref.candidates;
    }
    for (const path of candidates) {
      let src: string | undefined;
      try {
        src = await load(path);
      } catch {
        continue;
      }
      if (usableSrc(src)) {
        found.set(`${kind}\u0000${target}`, src);
        break;
      }
    }
  }
  return { src: (target, kind) => found.get(`${kind}\u0000${target}`) };
}

function imagesHtml(embeds: readonly ImageEmbed[], images: NoteImages): string {
  const parts = embeds.map(({ target, kind, name }) => {
    const src = images.src(target, kind);
    return usableSrc(src) ? `<img alt="${escapeHtml(name)}" src="${escapeHtml(src)}">` : `<span>[${escapeHtml(name)}]</span>`;
  });
  return `<p class="img">${parts.join('')}</p>`;
}

/** 맨 위 요소마다 한 묶음: 이어지는 목록 항목은 목록 하나(`<ul>`)이고, 나머지 블록은 하나씩이다. */
function topLevelGroups(blocks: readonly WorksheetBlock[]): WorksheetBlock[][] {
  const groups: WorksheetBlock[][] = [];
  for (const block of blocks) {
    const last = groups[groups.length - 1];
    if (block.kind === 'item' && last?.[0].kind === 'item') last.push(block);
    else groups.push([block]);
  }
  return groups;
}

/** 노트를 맨 위 블록마다 HTML 문자열 하나로(머리말은 뗀다). */
export function renderNoteBlocks(markdown: string, images: NoteImages): string[] {
  const out: string[] = [];
  for (const seg of segments(markdown)) {
    switch (seg.type) {
      case 'heading':
        out.push(`<h${seg.level}>${inline(seg.text)}</h${seg.level}>`);
        break;
      case 'hr':
        out.push('<hr>');
        break;
      case 'images':
        out.push(imagesHtml(seg.embeds, images));
        break;
      case 'text':
        for (const group of topLevelGroups(parseWorksheetBlocks(seg.lines))) out.push(blocksHtml(group));
        break;
    }
  }
  return out;
}
