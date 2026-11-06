/**
 * 앞부분(front matter)을 읽을 글. 코어 parseFrontMatterYaml 은 글이 정확히 `---` 와 LF 로 시작해야 읽는다:
 * Windows 에서 만든 노트의 UTF-8 BOM 이나 CRLF 가 있으면 빈 객체를 돌려준다. 그래서 읽기 전에 BOM 을 떼고 CRLF 를 LF 로 바꾼다.
 * 읽기 전용이다. 쓰기는 processNote 가 디스크의 BOM 과 줄 끝을 그대로 지킨다.
 */
export function frontMatterText(raw: string): string {
  const body = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  return body.replace(/\r\n/g, '\n');
}
