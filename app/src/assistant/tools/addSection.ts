/**
 * `add_section`(assistant spec §4.4, plan Task 11A, R2/R8): 도우미만 쓰는 도구. core `update_section` 은 있는 제목만
 * 고치므로, "섹션 만들기"는 새 제목의 섹션을 이 도구로 붙인다. MCP 서버의 도구 목록(`appTools()` → `toolCatalog()`)에는
 * 들어가지 않는다.
 *
 * - 노트 끝에 `## heading` + 본문을 붙이거나, `after` 섹션(그 안의 하위 제목까지) 바로 뒤에 같은 수준으로 넣는다.
 * - 새 섹션의 이웃(같은 부모 아래 같은 수준)에 같은 제목이 있으면 거절한다. 연구자만 쓰는 섹션(Results & Discussions,
 *   QC Metrics, Discussion, Meta — 한국어 이름 포함)도 거절한다.
 * - 경로는 `appTools` 의 감싸기와 같이 범위(실험 폴더 + 사람이 적은 폴더) 안의 `.md` 만, 읽기·확인 전에 검사한다.
 * - 쓰기는 도구 문맥의 `writeNote`(열린 편집기를 아는 쓰기, 그 안에서 보관함 지킴이 `beforeWrite`)로만 한다.
 * - `describe()` 는 확인 대화상자가 이미 그리는 `sectionEdit` 미리보기에 `adding: true` 를 더해 돌려준다.
 */
import type { SectionEditPreview, ToolDef, ToolResult } from '@labnoteo/core';
import {
  findSectionMatches,
  listHeadings,
  normalizeHeadingText,
  sectionBodyEnd,
  stripRepeatedHeading,
} from '../../../vendor/labnoteo/packages/labnoteo-core/src/sections/sectionEdit';
import { t } from '../../i18n/t';
import { canonicalSection, RESEARCHER_ONLY_SECTIONS } from '../../labnote/context/chain';
import { scopeFailure, type ScopedToolContext } from '../../labnote/context/contextTools';
import { assertInScope, ScopeError, type Scope } from '../../labnote/context/scope';
import { coreT } from '../../labnote/i18n';

/** `add_section` 의 미리보기: `sectionEdit` 그대로(지우는 줄 없음) + 새 섹션이라는 표시와 `after`. */
export type AddSectionPreview = SectionEditPreview & { adding: true; after?: string };

/** core 의 거절 미리보기(`ToolError`, 패키지 밖으로 내보내지 않는다). */
type ToolError = { error: string; code?: string; params?: string[] };

/** 미리보기에 보이는 줄 수와 줄 길이(core `update_section` 과 같다). */
const PREVIEW_LINES = 8;
const PREVIEW_LINE_CHARS = 160;
/** 제목 글자 수 상한. */
const HEADING_MAX = 200;

const folderKey = (p: string): string =>
  p.normalize('NFC').replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/\/+$/, '').toLowerCase();

/** 범위 없이(실험 밖 대화) 받을 수 있는 경로: 보관함 안의 `.md`, `..`·절대·드라이브·점 폴더는 안 된다. */
function plainVaultNote(path: string): string | undefined {
  if (!path || /[\0:]/.test(path)) return undefined;
  const slashed = path.replace(/\\/g, '/');
  if (slashed.startsWith('/')) return undefined;
  const parts: string[] = [];
  for (const part of slashed.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..' || part.startsWith('.')) return undefined;
    parts.push(part);
  }
  const out = parts.join('/');
  return /\.md$/i.test(out) ? out : undefined;
}

/** `documentPath` 를 검사해 정규화한 경로, 아니면 거절 결과. */
function checkPath(scope: Scope | undefined, ctx: ScopedToolContext, raw: string): string | ToolError {
  const s = scope ?? ctx.scope;
  if (!s) {
    const ok = plainVaultNote(raw);
    return ok ?? { error: `documentPath must be a Markdown note inside the vault: ${raw}`, code: 'outOfScope', params: [raw, ''] };
  }
  const named = [...s.named, ...(ctx.allowedFolders ?? [])].filter((f) => folderKey(f) !== folderKey(s.folder));
  try {
    return assertInScope({ ...s, named }, raw);
  } catch (err) {
    if (err instanceof ScopeError) {
      const res = scopeFailure(new ScopeError('outOfScope', [raw, s.folder]));
      return { error: res.error ?? 'outOfScope', code: res.code, params: res.params };
    }
    throw err;
  }
}

interface Planned {
  documentPath: string;
  heading: string;
  after?: string;
  /** 새 노트 글. */
  md: string;
  /** 새 제목의 1-based 줄. */
  line: number;
  parentHeading: string;
  /** 미리보기 줄(제목 줄 + 본문의 빈 줄 아닌 줄). */
  added: string[];
}

const isError = (x: unknown): x is ToolError => !!x && typeof x === 'object' && 'error' in x;
const str = (args: Record<string, unknown>, key: string): string | undefined =>
  typeof args[key] === 'string' ? (args[key] as string) : undefined;

/** 호출을 검사하고 새 글을 만든다. `describe` 와 `handler` 가 같은 것을 쓰므로 둘이 어긋나지 않는다. */
async function plan(scope: Scope | undefined, ctx: ScopedToolContext, args: Record<string, unknown>): Promise<Planned | ToolError> {
  const rawPath = str(args, 'documentPath');
  const rawHeading = str(args, 'heading');
  const rawBody = str(args, 'body');
  const rawAfter = str(args, 'after');
  if (!rawPath?.trim() || rawHeading === undefined || rawBody === undefined) {
    return { error: 'documentPath, heading and body are required; nothing was written.' };
  }
  const documentPath = checkPath(scope, ctx, rawPath.trim());
  if (isError(documentPath)) return documentPath;

  if (/[\r\n]/.test(rawHeading.trim())) return { error: 'heading must be one line; nothing was written.' };
  const heading = rawHeading.trim().replace(/^#{1,6}\s*/, '').trim();
  if (!heading) return { error: 'heading is empty; nothing was written.' };
  if (heading.length > HEADING_MAX) return { error: `heading is longer than ${HEADING_MAX} characters; nothing was written.` };
  const canon = canonicalSection(heading);
  if (canon && RESEARCHER_ONLY_SECTIONS.includes(canon)) {
    return {
      error: `"${heading}" is a researcher-only section (${RESEARCHER_ONLY_SECTIONS.join(', ')}); the researcher writes it. Nothing was written.`,
      code: 'researcherOnly',
      params: [heading],
    };
  }

  if (!(await ctx.fs.exists(documentPath))) return { error: `File not found: ${documentPath}` };
  const md = await ctx.fs.read(documentPath);
  const eol = md.includes('\r\n') ? '\r\n' : '\n';
  const lines = md.split(/\r?\n/);
  const headings = listHeadings(md);

  // Where it goes, at which level, and which headings are its neighbours.
  let at = lines.length;
  let level = 2;
  let parentHeading = '';
  let siblings = headings.filter((h) => h.level <= 2);
  const after = rawAfter?.trim().replace(/^#{1,6}\s*/, '').trim() || undefined;
  if (after) {
    const found = findSectionMatches(md, after);
    if (found.length === 0) {
      const known = headings.map((h) => h.text).slice(0, 40);
      return {
        error: `Section "${after}" was not found in ${documentPath}; nothing was written. Headings: ${known.join(' | ') || 'none'}.`,
        code: 'section_not_found',
        params: [after],
      };
    }
    if (found.length > 1) {
      return {
        error: `"${after}" names ${found.length} sections in ${documentPath} (under ${found.map((m) => m.parentHeading || 'the top').join(', ')}); nothing was written. Use a heading that appears once.`,
        code: 'ambiguous_section',
        params: [after],
      };
    }
    const target = found[0];
    level = target.level;
    parentHeading = target.parentHeading;
    at = sectionBodyEnd(lines, target.line, target.level);
    const parent = [...headings].reverse().find((h) => h.line < target.line && h.level < target.level);
    const from = parent ? parent.line : -1;
    const to = parent ? sectionBodyEnd(lines, parent.line, parent.level) : lines.length;
    siblings = headings.filter((h) => h.line > from && h.line < to && h.level === target.level);
  }
  const wanted = normalizeHeadingText(heading);
  const same = siblings.find((h) => normalizeHeadingText(h.text) === wanted);
  if (same) {
    return {
      error: `${documentPath} already has the section "${same.text}" there; nothing was written. Use update_section to change it.`,
      code: 'duplicateHeading',
      params: [same.text],
    };
  }

  const body = stripRepeatedHeading(rawBody, heading).replace(/^(?:[ \t]*\r?\n)+/, '').trimEnd();
  const tooHigh = listHeadings(body).find((h) => h.level <= level);
  if (tooHigh) {
    return {
      error:
        `body has the heading "${'#'.repeat(tooHigh.level)} ${tooHigh.text}", which would start another section after "${heading}"; nothing was written. ` +
        `Send only the body, or use deeper headings (${'#'.repeat(Math.min(level + 1, 6))} or more) inside it.`,
    };
  }

  const head = lines.slice(0, at);
  while (head.length > 0 && head[head.length - 1].trim() === '') head.pop();
  const tail = lines.slice(at);
  while (tail.length > 0 && tail[0].trim() === '') tail.shift();
  const headingLine = `${'#'.repeat(level)} ${heading}`;
  const bodyLines = body ? body.split(/\r?\n/) : [];
  const block = [headingLine, ...(bodyLines.length > 0 ? ['', ...bodyLines] : [])];
  const out = [...head, ...(head.length > 0 ? [''] : []), ...block, ...(tail.length > 0 ? ['', ...tail] : [''])];
  return {
    documentPath,
    heading,
    ...(after ? { after } : {}),
    md: out.join(eol),
    line: head.length + (head.length > 0 ? 1 : 0) + 1,
    parentHeading,
    added: [headingLine, ...bodyLines.filter((l) => l.trim() !== '')],
  };
}

function preview(p: Planned): AddSectionPreview {
  return {
    kind: 'sectionEdit',
    adding: true,
    documentPath: p.documentPath,
    heading: p.heading,
    parentHeading: p.parentHeading,
    occurrence: 1,
    total: 1,
    line: p.line,
    removedLines: 0,
    removedSubheadings: 0,
    clearing: false,
    removedText: [],
    removedMore: 0,
    addedText: p.added.slice(0, PREVIEW_LINES).map((l) => (l.length > PREVIEW_LINE_CHARS ? `${l.slice(0, PREVIEW_LINE_CHARS)}…` : l)),
    addedMore: Math.max(0, p.added.length - PREVIEW_LINES),
    ...(p.after ? { after: p.after } : {}),
  };
}

/** `add_section` 의 미리보기인가(확인 글을 앱 말로 쓰려고). */
export function isAddSectionPreview(p: unknown): p is AddSectionPreview {
  return !!p && typeof p === 'object' && (p as { kind?: unknown }).kind === 'sectionEdit' && (p as { adding?: unknown }).adding === true;
}

/**
 * 확인 대화상자의 본문: 어디에 어떤 섹션을 더하는지(앱 말), 그리고 더해지는 줄. `translate` 는 core 문장
 * ("Lines added:")의 번역기(`env.host.t`, 기본 `coreT`).
 */
export function addSectionText(p: AddSectionPreview, translate: (key: string, ...args: string[]) => string = coreT): string {
  const head = p.after ? t('assistant.addSection.after', p.heading, p.after) : t('assistant.addSection.atEnd', p.heading);
  const rows = p.addedText.map((l) => `  ${l}`);
  if (p.addedMore > 0) rows.push(`  ${translate('(+{0} more line(s))', String(p.addedMore))}`);
  return [head, [translate('Lines added:'), ...rows].join('\n')].join('\n\n');
}

/** `scope`: 이번 차례의 실험(없으면 도구 문맥의 것, 그것도 없으면 보관함 안의 `.md` 아무것). */
export function addSectionTool(scope: Scope | undefined): ToolDef {
  return {
    name: 'add_section',
    mutates: true,
    description:
      'Add a NEW section to a Markdown note: "## heading" and its body at the end of the note, or, with "after", right after that section ' +
      '(its nested headings included) at the same heading level. Only for a heading the note does not have there yet; to change an existing ' +
      'section use update_section. Never for the researcher-only sections (Results & Discussions, QC Metrics, Discussion, Meta).',
    inputSchema: {
      type: 'object',
      required: ['documentPath', 'heading', 'body'],
      properties: {
        documentPath: { type: 'string', description: 'Vault-relative path of the note.' },
        heading: { type: 'string', description: 'Text of the new heading, without the "#" marks.' },
        body: { type: 'string', description: 'Markdown body of the new section, without its heading. May be "" for an empty section.' },
        after: { type: 'string', description: 'Heading of the section the new one goes after. Omit to add it at the end of the note.' },
      },
    },
    async describe(ctx, args) {
      const p = await plan(scope, ctx as ScopedToolContext, args);
      return isError(p) ? p : preview(p);
    },
    async handler(ctx, args): Promise<ToolResult> {
      const p = await plan(scope, ctx as ScopedToolContext, args);
      if (isError(p)) return { ok: false, ...p };
      if (ctx.writeNote) await ctx.writeNote(p.documentPath, p.md);
      else await ctx.fs.write(p.documentPath, p.md);
      return { ok: true, data: { documentPath: p.documentPath, heading: p.heading, line: p.line } };
    },
  };
}
