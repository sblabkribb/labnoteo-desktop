import type { Extension } from '@codemirror/state';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { styleTags, tags } from '@lezer/highlight';
// 타입만 가져온다(런타임에는 지워진다): @lezer/markdown 은 @codemirror/lang-markdown 이 이미 싣고 오는 그 파서다.
import type { MarkdownConfig, MarkdownParser } from '@lezer/markdown';

export const FRONTMATTER_OPEN = /^---[ \t\r]*$/;
export const FRONTMATTER_CLOSE = /^(?:---|\.\.\.)[ \t\r]*$/;

/**
 * 노트 맨 앞의 YAML 머리말. 문서 위치 0 의 `---` 줄에서 시작해 `---` 또는 `...` 줄까지를 `Frontmatter` 노드 하나로 낸다.
 * 안은 파싱하지 않는다(자식 노드가 없다). 이것이 없으면 CommonMark 는 `---` 를 가로줄로, 그 아래 YAML 을 SetextHeading2 로 읽는다.
 * 닫는 줄이 없으면 문서 끝까지를 머리말로 본다: 블록 파서는 한 줄 앞까지만 내다볼 수 있어 되돌릴 수 없고,
 * 노드가 자기가 기댄 글자를 모두 덮어야 증분 파싱이 다시 읽기와 같은 결과를 낸다.
 */
export const Frontmatter: MarkdownConfig = {
  defineNodes: [{ name: 'Frontmatter', block: true }],
  props: [styleTags({ Frontmatter: tags.meta })],
  parseBlock: [
    {
      name: 'Frontmatter',
      before: 'LinkReference',
      parse(cx, line) {
        if (cx.lineStart !== 0 || line.pos !== 0 || cx.parentType().name !== 'Document' || !FRONTMATTER_OPEN.test(line.text)) return false;
        let end = line.text.length;
        while (cx.nextLine()) {
          end = cx.lineStart + line.text.length;
          if (FRONTMATTER_CLOSE.test(line.text)) {
            cx.nextLine();
            break;
          }
        }
        cx.addElement(cx.elt('Frontmatter', 0, end));
        return true;
      },
    },
  ],
};

/**
 * `[[target]]`, `[[target|alias]]` 와 `![[…]]` 임베드 (Obsidian 문법). 한 줄을 넘지 않고, 안에 `[` `]` 줄바꿈이 없으며
 * 대상이 비어 있지 않을 때만 노드가 된다. 그렇지 않으면 -1 을 돌려 Link 등 다음 파서가 그대로 읽는다(짝 없는 `]]` 는 글자다).
 * 별칭 구분자는 첫 `|` 이다. 표 칸 글자에서는 그 파이프가 백슬래시로 escape 되어 있으므로, 앞의 백슬래시까지 구분 표시에 넣는다.
 * 자식: WikiLinkMark(`[[` 또는 `![[`), WikiTarget, [WikiLinkMark(`|`), WikiAlias], WikiLinkMark(`]]`).
 */
const WIKI = /^!?\[\[([^[\]\n\r]+)\]\]/;

export const WikiLinks: MarkdownConfig = {
  defineNodes: [
    { name: 'WikiLink', style: tags.link },
    { name: 'Embed', style: tags.link },
    { name: 'WikiLinkMark', style: tags.processingInstruction },
    { name: 'WikiTarget' },
    { name: 'WikiAlias' },
  ],
  parseInline: [
    {
      name: 'WikiLink',
      before: 'Link',
      parse(cx, next, pos) {
        const embed = next === 33; /* ! */
        if (!embed && next !== 91 /* [ */) return -1;
        const m = WIKI.exec(cx.slice(pos, Math.min(cx.end, pos + 2048)));
        if (!m) return -1;
        const open = pos + (embed ? 3 : 2);
        const end = pos + m[0].length;
        const close = end - 2;
        const inner = m[1];
        const bar = inner.indexOf('|');
        const children = [cx.elt('WikiLinkMark', pos, open)];
        if (bar < 0) {
          children.push(cx.elt('WikiTarget', open, close));
        } else {
          const escaped = bar > 0 && inner[bar - 1] === '\\';
          const markFrom = open + bar - (escaped ? 1 : 0);
          if (markFrom === open) return -1; // 대상이 비었다
          children.push(cx.elt('WikiTarget', open, markFrom), cx.elt('WikiLinkMark', markFrom, open + bar + 1));
          if (open + bar + 1 < close) children.push(cx.elt('WikiAlias', open + bar + 1, close));
        }
        children.push(cx.elt('WikiLinkMark', close, end));
        return cx.addElement(cx.elt(embed ? 'Embed' : 'WikiLink', pos, end, children));
      },
    },
  ],
};

/** lezer 의 강조 구분자와 같은 문장부호 판정 (Strikethrough 와 같은 좌우 flanking 규칙에 쓴다). */
const PUNCT = /[\p{S}\p{P}]/u;
const HighlightDelim = { resolve: 'Highlight', mark: 'HighlightMark' };

/** `==하이라이트==` (Obsidian). GFM Strikethrough 와 똑같이 두 글자 구분자로 읽는다. `===` 는 아니다. */
export const Highlight: MarkdownConfig = {
  defineNodes: [
    { name: 'Highlight', style: { 'Highlight/...': tags.special(tags.content) } },
    { name: 'HighlightMark', style: tags.processingInstruction },
  ],
  parseInline: [
    {
      name: 'Highlight',
      after: 'Emphasis',
      parse(cx, next, pos) {
        if (next !== 61 /* = */ || cx.char(pos + 1) !== 61 || cx.char(pos + 2) === 61) return -1;
        const before = cx.slice(pos - 1, pos);
        const after = cx.slice(pos + 2, pos + 3);
        const sBefore = /\s|^$/.test(before);
        const sAfter = /\s|^$/.test(after);
        const pBefore = PUNCT.test(before);
        const pAfter = PUNCT.test(after);
        return cx.addDelimiter(
          HighlightDelim,
          pos,
          pos + 2,
          !sAfter && (!pAfter || sBefore || pBefore),
          !sBefore && (!pBefore || sAfter || pAfter),
        );
      },
    },
  ],
};

const EXTENSIONS = [Frontmatter, WikiLinks, Highlight];

/** 단위 테스트와 이후 작업(표 등)이 직접 쓰는 파서: GFM + 머리말 + 위키링크 + 하이라이트. 편집기의 언어와 같은 설정이다. */
export const labnoteParser: MarkdownParser = (markdownLanguage.parser as MarkdownParser).configure(EXTENSIONS);

/**
 * 편집기의 마크다운 언어: GFM(표·할 일·취소선) 위에 머리말, 위키링크·임베드, 하이라이트 파서를 얹는다.
 * lang-markdown 의 자체 Enter/Backspace keymap 은 끈다(`addKeymap: false`): 바깥 편집기가 한글 조합을 지키는
 * 목록 키(live/listKeys.ts)를 단다. 켜 두면 같은 키의 처리기가 둘이 되어 하나는 영영 돌지 않는다.
 * 셀 편집기도 이 언어를 싣지만 칸은 한 줄이라 Enter 를 스스로 다룬다.
 * HTML 태그 완성도 끈다(`completeHTMLTags: false`): `<` 를 칠 때마다 태그 목록이 뜨면 글쓰기를 방해하고, 편집기의 자동 완성은
 * 위키링크(`[[`)만 제안한다.
 */
export function labnoteMarkdown(): Extension {
  return markdown({ base: markdownLanguage, extensions: EXTENSIONS, addKeymap: false, completeHTMLTags: false });
}
