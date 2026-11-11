import { parseFrontMatterYaml } from '@labnoteo/core';
import { findSampleReferenceSpans } from '@labnoteo/core/lib/sampleStorage';
import type { InfoFinding } from '../integrations/githubIpc';
import type { ResolvedLink } from '../links/linkIndex';
import type { CollectedInfo } from './githubFlow';

/** 노트에서 모으는 데 쓰는 것: 보관함 파일 목록, 읽기, 링크 색인의 풀린 링크, 시료 종류. */
export interface CollectDeps {
  files: readonly string[];
  read(path: string): Promise<string>;
  resolved(path: string): ResolvedLink[];
  sampleTypes: readonly string[];
}

const IMAGE = /\.(png|jpe?g|gif|webp|svg|bmp|tiff?|heic)$/i;
const NOTE = /\.md$/i;

function inside(folder: string, path: string): boolean {
  return path.startsWith(`${folder}/`);
}

function strings(v: unknown): string[] {
  if (typeof v === 'string') return v.trim() ? [v.trim()] : [];
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim());
  return [];
}

/**
 * 올리기 미리보기의 표시용 발견과 시료 ID 를 모은다(P-R3, P-R4). 모두 표시용이다: Rust 는 이것으로 파일을 더하지 않는다.
 * - 시료 ID: 폴더 안 노트의 `findSampleReferenceSpans`.
 * - `[[…]]` 링크(위키·임베드), 폴더 밖 노트를 가리키는 링크(다른 실험), 노트에 넣었지만 폴더 밖에 있는 파일,
 *   폴더 안에서 어느 노트도 쓰지 않는 그림: 앱의 링크 색인으로.
 * - 실험 제목과 작성자: 실험 README 의 머리말(없으면 폴더 이름).
 */
export async function collectInfoWith(folder: string, d: CollectDeps): Promise<CollectedInfo> {
  const own = d.files.filter((p) => inside(folder, p));
  const notes = own.filter((p) => NOTE.test(p));
  const sampleIds = new Set<string>();
  const used = new Set<string>();
  const outside = new Set<string>();
  const outsideByNote: Record<string, string[]> = {};
  let wikiLinks = 0;
  let crossLinks = 0;
  for (const note of notes) {
    let text = '';
    try {
      text = (await d.read(note)).replace(/\r\n/g, '\n');
    } catch {
      text = '';
    }
    for (const span of findSampleReferenceSpans(text, d.sampleTypes)) sampleIds.add(span.id);
    for (const r of d.resolved(note)) {
      if (r.link.kind === 'wiki' || r.link.kind === 'embed') wikiLinks += 1;
      const target = r.target;
      if (!target) continue;
      if (inside(folder, target)) {
        used.add(target);
        continue;
      }
      if (NOTE.test(target)) crossLinks += 1;
      else {
        outside.add(target);
        const mine = (outsideByNote[note] ??= []);
        if (!mine.includes(target)) mine.push(target);
      }
    }
  }
  const unused = own.filter((p) => IMAGE.test(p) && !used.has(p));

  const name = folder.slice(folder.lastIndexOf('/') + 1);
  let title = name;
  let authors: string[] = [];
  for (const readme of [`${folder}/README.labnote.md`, `${folder}/README.md`]) {
    if (!d.files.includes(readme)) continue;
    try {
      const fm = parseFrontMatterYaml((await d.read(readme)).replace(/\r\n/g, '\n')).frontMatter;
      const t = strings(fm.title)[0];
      if (t) title = t;
      authors = strings(fm.author);
    } catch {
      // 머리말을 못 읽으면 폴더 이름으로 둔다.
    }
    break;
  }

  const infoFindings: InfoFinding[] = [];
  if (authors.length > 0) infoFindings.push({ kind: 'author', names: authors });
  if (crossLinks > 0) infoFindings.push({ kind: 'crossLinks', count: crossLinks });
  if (wikiLinks > 0) infoFindings.push({ kind: 'wikiLinks', count: wikiLinks });
  if (outside.size > 0) infoFindings.push({ kind: 'outside', count: outside.size, paths: [...outside].sort() });
  if (unused.length > 0) infoFindings.push({ kind: 'unused', count: unused.length, paths: unused.sort() });
  for (const paths of Object.values(outsideByNote)) paths.sort();
  return { sampleIds: [...sampleIds].sort(), infoFindings, title, outsideByNote };
}
