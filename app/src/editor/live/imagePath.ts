/**
 * 라이브 미리보기의 이미지 경로(계획 Task 21). 순수 함수만 있다: IPC 를 부르기 전에 여기서 걸러 낸다.
 * - `![alt](경로)` 와 `![[이름.png|200]]` 의 대상이 이미지인지, 보관함 안의 어느 경로인지 정한다.
 * - 보관함 밖으로 나가는 경로(`..` 넘침, `%2e%2e` 포함), 절대·드라이브·UNC 경로, 스킴(`https:`)은 null 이다.
 *   Rust(`vault_read_image`)도 다시 가두지만, 걸러 낼 수 있는 것은 IPC 전에 걸러 낸다.
 */

/** Rust `fs.rs` 의 `IMAGE_EXTS` 와 같은 목록. image.test.ts 가 두 줄을 맞춰 본다. */
export const IMAGE_EXTS: readonly string[] = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif', 'svg'];

/** 확장자 → Blob 의 MIME 형식. */
export const MIME: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
};

/** `#조각` 과 `?질의` 를 뗀 경로 부분. */
const pathPart = (target: string) => target.split('#')[0].split('?')[0];

/** 경로의 소문자 확장자(없으면 ''). */
export function extOf(path: string): string {
  const base = pathPart(path).split('/').pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

/** 대상이 이미지 파일인가(확장자로, 대소문자 무시). */
export function isImageTarget(target: string): boolean {
  return IMAGE_EXTS.includes(extOf(target.trim()));
}

export type ImageRef = { kind: 'paths'; candidates: string[] } | { kind: 'name'; name: string };

/** 두 글자 이상의 URI 스킴(`https:`, `data:`). 한 글자(`C:`)는 드라이브라 아래에서 따로 거른다. */
const SCHEME = /^[a-z][a-z0-9+.-]+:/i;

/** `base`(폴더 조각들)에서 `rel` 을 따라간 경로. 보관함 밖으로 나가거나 비면 null. */
function join(base: string[], rel: string): string | null {
  const parts = [...base];
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.length ? parts.join('/') : null;
}

/**
 * 노트 `notePath`(보관함 기준 POSIX 경로) 안의 이미지 대상이 가리키는 곳.
 * - `%XX` 를 먼저 푼다(위키 대상은 풀 수 없으면 글자 그대로).
 * - 스킴, 절대(`/`), UNC·역슬래시, 드라이브(`C:`), 콜론, 제어 문자는 null.
 * - Markdown 이거나 `/` 가 든 위키 대상: 노트 기준, 그다음 보관함 기준 후보(보관함을 벗어나는 후보는 뺀다. 둘 다 벗어나면 null).
 * - `/` 가 없는 위키 대상: 이름(보관함 이미지 색인에서 찾는다, Obsidian 과 같다).
 */
export function resolveImagePath(notePath: string, target: string, kind: 'md' | 'wiki'): ImageRef | null {
  let t = target.trim();
  if (kind === 'md' && t.startsWith('<') && t.endsWith('>')) t = t.slice(1, -1).trim();
  if (!t || SCHEME.test(t)) return null;
  t = kind === 'md' ? pathPart(t) : t.split('#')[0];
  let rel: string;
  try {
    rel = decodeURIComponent(t);
  } catch {
    if (kind === 'md') return null;
    rel = t;
  }
  rel = rel.trim();
  if (!rel || rel.startsWith('/') || rel.includes('\\') || rel.includes(':') || /[\u0000-\u001f]/.test(rel)) return null;
  if (kind === 'wiki' && !rel.includes('/')) return { kind: 'name', name: rel };
  const noteDir = notePath.split('/').slice(0, -1);
  const candidates = [join(noteDir, rel), join([], rel)].filter((p): p is string => p !== null);
  const unique = [...new Set(candidates)];
  return unique.length ? { kind: 'paths', candidates: unique } : null;
}

const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1);
const dirName = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

/**
 * 이름만 쓴 임베드(`![[x.png]]`)를 보관함 이미지 경로 목록에서 찾는다: 파일 이름이 같은(대소문자 무시) 것 가운데
 * 노트와 같은 폴더의 것, 없으면 가장 짧은 경로, 길이가 같으면 사전순 앞의 것. 없으면 null.
 */
export function pickByName(notePath: string, name: string, paths: readonly string[]): string | null {
  const want = name.toLowerCase();
  const matches = paths.filter((p) => baseName(p).toLowerCase() === want);
  if (!matches.length) return null;
  const here = dirName(notePath);
  const local = matches.filter((p) => dirName(p) === here);
  const pool = local.length ? local : matches;
  return [...pool].sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0))[0];
}

/** `200` 또는 `200x100`(Obsidian 의 크기 문법). 0 이나 숫자가 아니면 null. */
export function parseSize(s: string): { width: number; height?: number } | null {
  const m = /^\s*(\d{1,5})(?:\s*x\s*(\d{1,5}))?\s*$/i.exec(s);
  if (!m) return null;
  const width = Number(m[1]);
  if (width <= 0) return null;
  if (m[2] === undefined) return { width };
  const height = Number(m[2]);
  return height > 0 ? { width, height } : null;
}

/** 대체 글 `gel|300` → 글 'gel' 과 크기. 마지막 `|` 뒤가 크기가 아니면 글 전체가 대체 글이다. 글 전체가 크기면 대체 글은 비었다. */
export function splitAltSize(alt: string): { alt: string; size: { width: number; height?: number } | null } {
  const bar = alt.lastIndexOf('|');
  if (bar < 0) {
    const size = parseSize(alt);
    return size ? { alt: '', size } : { alt, size: null };
  }
  const size = parseSize(alt.slice(bar + 1));
  return size ? { alt: alt.slice(0, bar), size } : { alt, size: null };
}
