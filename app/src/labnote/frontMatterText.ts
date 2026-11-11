/**
 * 앞부분(front matter)을 읽을 글. 코어 parseFrontMatterYaml 은 글이 정확히 `---` 와 LF 로 시작해야 읽는다:
 * Windows 에서 만든 노트의 UTF-8 BOM 이나 CRLF 가 있으면 빈 객체를 돌려준다. 그래서 읽기 전에 BOM 을 떼고 CRLF 를 LF 로 바꾼다.
 * 읽기 전용이다. 쓰기는 processNote 가 디스크의 BOM 과 줄 끝을 그대로 지킨다.
 */
export function frontMatterText(raw: string): string {
  const body = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  return body.replace(/\r\n/g, '\n');
}

/**
 * 첫 줄 앞의 빈 줄을 뺀 글: 빈 줄 다음에 `---` … `---` 블록이 오면 그 블록이 앞부분이 되도록 빈 줄만 지운다(BOM 은 남긴다).
 * 그렇지 않으면 그대로다. 앞부분을 고치는 README 명령(상태 바꾸기·지우기, 논의 표시)이 쓰기 전에 부른다: 빈 줄이 있으면
 * 코어 setFrontMatterKeys 가 블록을 못 찾고 맨 앞에 둘째 블록을 만들었다.
 */
export function liftFrontMatter(text: string): string {
  const bom = text.charCodeAt(0) === 0xfeff ? '﻿' : '';
  const rest = text.slice(bom.length);
  const m = /^(?:[ \t]*\r?\n)+(?=---[ \t]*\r?\n(?:[^\n]*\n)*?---[ \t]*(?:\r?\n|$))/.exec(rest);
  return m ? bom + rest.slice(m[0].length) : text;
}
