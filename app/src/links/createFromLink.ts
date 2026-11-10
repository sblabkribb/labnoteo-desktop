/**
 * Opening a link target and creating a note from an unresolved link (plan SP4 Task 10, D5 and D6).
 * - `newNotePath` decides where `[[x]]` creates its note: no `/` means the source note's folder, a `/` means
 *   vault-rooted, and `./`/`../` are relative to the source. `.md` is appended unless present; image and
 *   attachment link paths are refused.
 * - `createFromLink` writes with the expect-empty `fs.modify` pattern of `newNoteIn`, so nothing is overwritten.
 * - `openLinkTarget` dispatches an editor `OpenTarget`: a note opens at its subpath line, an unresolved link
 *   creates its note, and an external URL goes to `openExternal`.
 * - `handleOpenLink` is the editor's entry point: failures become notices (runCommand), and while the command
 *   context is still loading a note link still opens and anything else says so.
 */
import type { OpenTarget } from '../editor/live/links';
import { ERROR_KINDS, hasErrorKind } from '../fs/errorKinds';
import { t } from '../i18n/t';
import type { CommandContext } from '../labnote/commands/context';
import { runCommand } from '../labnote/commands/runCommand';
import { warnIfWindowsPathTooLong } from '../labnote/port/experiments';
import { ATTACHMENT_EXTS, IMAGE_EXTS, createResolver, labnoteFallback } from './resolve';
import { subpathLine } from './subpath';

const dirOf = (path: string) => {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
};

function extOf(name: string): string {
  const seg = name.slice(name.lastIndexOf('/') + 1);
  const i = seg.lastIndexOf('.');
  return i < 0 ? '' : seg.slice(i + 1).toLowerCase();
}

/** Joins `base` and `rel` and folds `.` and `..`. A `..` above the vault root stays in the result. */
function normalize(base: string, rel: string): string {
  const out: string[] = [];
  for (const seg of [...base.split('/'), ...rel.split('/')]) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..' && out.length > 0 && out[out.length - 1] !== '..') out.pop();
    else out.push(seg);
  }
  return out.join('/');
}

/** Where a note created from `linkpath` (written in `sourcePath`) goes (D6). */
export function newNotePath(linkpath: string, sourcePath: string): string | { refused: 'notNote' | 'invalid' } {
  const lp = linkpath.trim();
  // `[[.]]`, `[[sub/..]]` and `[[sub/]]` name a folder, not a note.
  const last = lp.slice(lp.lastIndexOf('/') + 1);
  if (last === '' || last === '.' || last === '..') return { refused: 'invalid' };
  const ext = extOf(lp);
  if (IMAGE_EXTS.has(ext) || ATTACHMENT_EXTS.has(ext)) return { refused: 'notNote' };
  const relative = lp.startsWith('./') || lp.startsWith('../');
  const base = !lp.includes('/') || relative ? dirOf(sourcePath) : '';
  const path = normalize(base, lp);
  return /\.md$/i.test(path) ? path : path + '.md';
}

/** The write found content: the note appeared between the check and the write. */
class NoteExistsError extends Error {}

const refusedName = (e: unknown) => hasErrorKind(e, ERROR_KINDS.escape) || hasErrorKind(e, ERROR_KINDS.forbidden);

/** True when `path` is a readable file whose name is spelled exactly so in its folder's listing. */
async function isNoteAt(ctx: CommandContext, path: string): Promise<boolean> {
  try {
    const names = await ctx.host.fs.list(dirOf(path));
    if (!names.includes(path.slice(path.lastIndexOf('/') + 1))) return false;
    await ctx.host.fs.read(path);
    return true;
  } catch {
    return false;
  }
}

/** Creates the empty note an unresolved link names and opens it. Returns its path, or undefined. */
export async function createFromLink(ctx: CommandContext, linkpath: string, sourcePath: string): Promise<string | undefined> {
  const { host } = ctx;
  const path = newNotePath(linkpath, sourcePath);
  if (typeof path !== 'string') {
    host.notify('warn', path.refused === 'notNote' ? t('links.create.notNote', linkpath) : t('fileOps.name.invalid'));
    return undefined;
  }
  // A path above the vault root, or one with no name left, can never be created.
  if (path.split('/').some((seg) => seg === '..') || /(^|\/)\.md$/i.test(path)) {
    host.notify('warn', t('fileOps.name.invalid'));
    return undefined;
  }
  try {
    // Inside the try: the real vault_exists refuses names Windows refuses (CON, `: ? *`) with escape.
    if (await host.fs.exists(path)) {
      // The index may not have caught up with a note made a moment ago: open it if it is a note at exactly
      // this path. Anything else (another case, a folder) is only reported. Nothing is ever overwritten.
      if (await isNoteAt(ctx, path)) {
        await ctx.openFile(path);
        return path;
      }
      host.notify('warn', t('fileOps.exists'));
      return undefined;
    }
    // The `.labnote` fallback (resolve.ts): `[[x]]` names `x.labnote.md` when there is no `x.md`. The resolver
    // already opens it when the index lists it; this covers an index that has not caught up, so a click never
    // creates a duplicate `x.md` beside it.
    const fallback = labnoteFallback(linkpath.trim());
    const labnotePath = fallback === null ? null : newNotePath(fallback, sourcePath);
    if (typeof labnotePath === 'string' && (await isNoteAt(ctx, labnotePath))) {
      await ctx.openFile(labnotePath);
      return labnotePath;
    }
    await host.fs.modify(path, (current) => {
      if (current !== '') throw new NoteExistsError();
      return '';
    });
  } catch (e) {
    if (e instanceof NoteExistsError) {
      host.notify('warn', t('fileOps.exists'));
      return undefined;
    }
    if (!refusedName(e)) throw e;
    host.notify('warn', t('fileOps.name.invalid'));
    return undefined;
  }
  ctx.refresh();
  warnIfWindowsPathTooLong(host, ctx.vaultRoot, path);
  host.notify('info', t('links.created', path));
  await ctx.openFile(path);
  return path;
}

/** Opens what an editor link points at. */
export async function openLinkTarget(
  ctx: CommandContext,
  target: OpenTarget,
  sourcePath: string,
  openExternal: (url: string) => Promise<unknown>,
): Promise<void> {
  switch (target.kind) {
    case 'note': {
      let line: number | undefined;
      if (target.subpath || target.anchor) {
        try {
          // Raw disk text: subpathLine numbers lines as the editor does (BOM, CRLF).
          line = subpathLine(await ctx.host.fs.read(target.path), { subpath: target.subpath, anchor: target.anchor });
        } catch {
          // Unreadable: open without a line; the editor shows its own read failure.
        }
      }
      if (line === undefined) await ctx.openFile(target.path);
      else await ctx.openFile(target.path, { line });
      return;
    }
    case 'create':
      await createFromLink(ctx, target.linkpath, sourcePath);
      return;
    case 'external':
      await openExternal(target.url);
      return;
    case 'attachment': {
      // The link index has no attachments: resolve by Obsidian's rules against the files in the tree.
      const r = createResolver(ctx.treeFiles?.() ?? []);
      const path = target.href !== undefined ? r.resolveMd(target.href, sourcePath) : r.resolveWiki(target.linkpath, sourcePath);
      if (path === null) {
        ctx.host.notify('info', t('viewer.missing', target.linkpath));
        return;
      }
      await ctx.openFile(path);
      return;
    }
  }
}

/** The editor's link click: never throws, never drops the click silently. */
export async function handleOpenLink(
  ctx: CommandContext | undefined,
  target: OpenTarget,
  sourcePath: string,
  openExternal: (url: string) => Promise<unknown>,
  fallback: { openFile: (path: string) => Promise<unknown>; notify: (kind: 'info', message: string) => void },
): Promise<void> {
  if (ctx) {
    await runCommand(ctx, () => openLinkTarget(ctx, target, sourcePath, openExternal));
    return;
  }
  // Vault settings are still loading: a note can open without the command context; the rest waits.
  if (target.kind === 'note') {
    try {
      await fallback.openFile(target.path);
    } catch (e) {
      console.error('[labnoteo] open link failed:', e);
    }
    return;
  }
  fallback.notify('info', t('links.settingsNotReady'));
}
