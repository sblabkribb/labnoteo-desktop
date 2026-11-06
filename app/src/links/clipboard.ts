/**
 * 링크 복사(SP4 Task 12): 편집기의 Copy link 와 파일 트리의 Copy wikilink 가 쓴다.
 * - 복사가 끝난 뒤에만 'links.copied' 를 알린다. 클립보드가 거부하면 던진다(메뉴의 runCommand 가 알림으로 바꾼다).
 * - 위키링크로 쓸 수 없는 이름(`#|^[]`)은 보관함 뿌리에서 시작하는 Markdown 링크로 복사한다(D13 의 인코딩).
 */
import { t } from '../i18n/t';
import { linkIndex } from './linkIndex';

export async function copyText(text: string, notify: (k: 'info' | 'warn', m: string) => void): Promise<void> {
  await navigator.clipboard.writeText(text);
  notify('info', t('links.copied'));
}

/** D13: a raw Markdown destination percent-encodes space, `(`, `)`, `<`, `>`, `#` and `%`. */
function encodeMdPath(path: string): string {
  return path.replace(/[ ()<>#%]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
}

const BACKSLASH = String.fromCharCode(92);

/** `[<basename>](</rooted path>)`: the label escapes `\`, `[` and `]`. */
export function markdownLinkFor(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/i, '');
  const label = name.replace(/[\\[\]]/g, (c) => BACKSLASH + c);
  return '[' + label + '](/' + encodeMdPath(path) + ')';
}

/** What Copy wikilink copies for a note in the tree. */
export function noteLinkText(path: string): string {
  const linktext = linkIndex.resolver().linktextFor(path, '');
  return linktext === null ? markdownLinkFor(path) : `[[${linktext}]]`;
}
