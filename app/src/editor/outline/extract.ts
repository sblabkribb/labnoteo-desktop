import type { TreeNode } from '@labnoteo/core';
// @labnoteo/core 가 내보내지 않는 기호라 상대 경로로 가져온다(편집 금지인 vendor 를 읽기만 한다).
import { UNIT_OP_HEADING_PATTERN } from '../../../vendor/labnoteo/packages/labnoteo-core/src/sections/workflowSectionParser';

/**
 * 노트 개요(계획 Task 19): 본문의 ATX 제목 목록. 편집기 상태가 아니라 글자에서 읽으므로 화면에 그려지지 않은
 * 긴 노트의 아래쪽 제목도 잡힌다.
 */
export interface OutlineItem {
  level: 1 | 2 | 3 | 4 | 5 | 6;
  text: string;
  /** 1부터 센 줄. */
  line: number;
  /** 유닛 오퍼레이션·워크플로 제목의 코드(`UHW010`, `WB030`). */
  code?: string;
  kind: 'heading' | 'unitOp' | 'workflow';
}

const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
/** 닫는 `#` 들: 앞에 공백이 있어야 한다(`# C#` 의 `#` 은 글자다). */
const CLOSING = /(?:^|[ \t]+)#+[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const FRONTMATTER_OPEN = /^---[ \t]*$/;
const FRONTMATTER_CLOSE = /^(?:---|\.\.\.)[ \t]*$/;
/** 워크플로 제목 `## [WB030 이름] 별칭`(links.ts 의 WORKFLOW_HEADING 과 같은 꼴). */
const WORKFLOW_HEADING = /^##\s+\[([A-Z]+\d+)\s+(.+?)\]\s*(.*)/;

/**
 * 본문 줄 표시: 맨 앞 머리말(`---` … `---`/`...`)과 ``` / ~~~ 울타리(여닫는 줄 포함) 안의 줄은 false.
 * 제목 목록과 링크의 블록 id 찾기가 같은 규칙을 쓴다.
 */
export function bodyLineMask(lines: readonly string[]): boolean[] {
  const body = new Array<boolean>(lines.length).fill(true);
  let i = 0;
  if (lines.length > 1 && FRONTMATTER_OPEN.test(lines[0].replace(/\r$/, ''))) {
    for (let j = 1; j < lines.length; j++) {
      if (FRONTMATTER_CLOSE.test(lines[j].replace(/\r$/, ''))) {
        body.fill(false, 0, j + 1);
        i = j + 1;
        break;
      }
    }
    // 닫히지 않은 머리말은 머리말이 아니다(본문으로 읽는다)
  }
  let fence: { ch: string; len: number } | null = null;
  for (; i < lines.length; i++) {
    const raw = lines[i].replace(/\r$/, '');
    const f = FENCE.exec(raw);
    if (fence) {
      body[i] = false;
      if (f && f[1][0] === fence.ch && f[1].length >= fence.len && raw.slice(f[0].length).trim() === '') fence = null;
      continue;
    }
    if (f) {
      body[i] = false;
      fence = { ch: f[1][0], len: f[1].length };
    }
  }
  return body;
}

/**
 * ATX 제목만 읽는다. 맨 앞의 머리말(`---` … `---`/`...`)과 ``` / ~~~ 울타리 코드 안은 건너뛴다(`bodyLineMask`).
 * 줄 끝의 `\r` 과 닫는 `#` 들은 떼고, 글이 빈 제목은 넣지 않는다.
 *
 * 줄 배열을 주면 그 배열의 번호를 쓴다. 편집기는 CodeMirror 의 줄(`doc.iterLines()`)을 넘겨야 한다: CRLF 가 많은
 * 섞인 파일은 CRLF 로만 줄을 나누므로, `doc.toString().split('\n')` 은 외톨이 LF 마다 줄 번호가 하나씩 밀린다.
 */
export function extractOutline(text: string | readonly string[]): OutlineItem[] {
  const lines = typeof text === 'string' ? text.split('\n') : text;
  const body = bodyLineMask(lines);
  const items: OutlineItem[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!body[i]) continue;
    const raw = lines[i].replace(/\r$/, '');
    const m = ATX.exec(raw);
    if (!m) continue;
    const level = m[1].length as OutlineItem['level'];
    const content = (m[2] ?? '').replace(CLOSING, '').trim();
    const heading = `${m[1]} ${content}`;
    const line = i + 1;
    const wf = level === 2 ? WORKFLOW_HEADING.exec(heading) : null;
    const uo = level === 3 ? UNIT_OP_HEADING_PATTERN.exec(heading) : null;
    const coded = wf ?? uo;
    if (coded) {
      const label = [coded[2].trim(), (coded[3] ?? '').trim()].filter(Boolean).join(' ');
      items.push({ level, text: label, code: coded[1], kind: wf ? 'workflow' : 'unitOp', line });
      continue;
    }
    if (!content) continue;
    items.push({ level, text: content, kind: 'heading', line });
  }
  return items;
}

const NODE_KIND = { heading: 'category', unitOp: 'unitOperation', workflow: 'workflow' } as const;
const NODE_ICON = { heading: undefined, unitOp: 'symbol-method', workflow: 'symbol-class' } as const;

/** 수준으로 겹친 트리. id 는 줄 번호(String(line)), 이름은 코드가 있으면 `코드 이름`. */
export function toTree(items: OutlineItem[]): TreeNode[] {
  const roots: TreeNode[] = [];
  const stack: { level: number; node: TreeNode }[] = [];
  for (const item of items) {
    const node: TreeNode = {
      id: String(item.line),
      label: item.code ? `${item.code} ${item.text}` : item.text,
      kind: NODE_KIND[item.kind],
      icon: NODE_ICON[item.kind],
    };
    while (stack.length && stack[stack.length - 1].level >= item.level) stack.pop();
    const parent = stack[stack.length - 1]?.node;
    if (parent) (parent.children ??= []).push(node);
    else roots.push(node);
    stack.push({ level: item.level, node });
  }
  return roots;
}

/** 커서가 든 제목: 줄이 cursorLine 이하인 마지막 항목. */
export function currentItem(items: OutlineItem[], cursorLine: number): OutlineItem | undefined {
  let found: OutlineItem | undefined;
  for (const item of items) {
    if (item.line > cursorLine) break;
    found = item;
  }
  return found;
}
