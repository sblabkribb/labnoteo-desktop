import type { Extension } from '@codemirror/state';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { styleTags, tags } from '@lezer/highlight';
// 타입만 가져온다(런타임에는 지워진다): @lezer/markdown 은 @codemirror/lang-markdown 이 이미 싣고 오는 그 파서다.
import type { MarkdownConfig, MarkdownParser } from '@lezer/markdown';

const OPEN = /^---[ \t\r]*$/;
const CLOSE = /^(?:---|\.\.\.)[ \t\r]*$/;

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
        if (cx.lineStart !== 0 || line.pos !== 0 || cx.parentType().name !== 'Document' || !OPEN.test(line.text)) return false;
        let end = line.text.length;
        while (cx.nextLine()) {
          end = cx.lineStart + line.text.length;
          if (CLOSE.test(line.text)) {
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

/** 단위 테스트와 이후 작업(표 등)이 직접 쓰는 파서: GFM + 머리말. 편집기의 언어와 같은 설정이다. */
export const labnoteParser: MarkdownParser = (markdownLanguage.parser as MarkdownParser).configure([Frontmatter]);

/** 편집기의 마크다운 언어: GFM(표·할 일·취소선) 위에 머리말 파서를 얹는다. */
export function labnoteMarkdown(): Extension {
  return markdown({ base: markdownLanguage, extensions: [Frontmatter] });
}
