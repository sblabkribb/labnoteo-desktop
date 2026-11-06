/**
 * Opening a link target and creating a note from an unresolved link (plan SP4 Task 10, D5 and D6).
 * - `newNotePath` decides where `[[x]]` creates its note: no `/` means the source note's folder, a `/` means
 *   vault-rooted, and `./`/`../` are relative to the source. `.md` is appended unless present; image and
 *   attachment link paths are refused.
 * - `createFromLink` writes with the expect-empty `fs.modify` pattern of `newNoteIn`, so nothing is overwritten.
 * - `openLinkTarget` dispatches an editor `OpenTarget`: a note opens at its subpath line, an unresolved link
 *   creates its note, and an external URL goes to `openExternal`.
 */
import type { OpenTarget } from '../editor/live/links';
import { ERROR_KINDS, hasErrorKind } from '../fs/errorKinds';
import { t } from '../i18n/t';
import type { CommandContext } from '../labnote/commands/context';
import { warnIfWindowsPathTooLong } from '../labnote/port/experiments';
import { ATTACHMENT_EXTS, IMAGE_EXTS } from './resolve';
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
export function newNotePath(linkpath: string, sourcePath: string): string | { refused: 'notNote' } {
  const lp = linkpath.trim();
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

/** Creates the empty note an unresolved link names and opens it. Returns its path, or undefined. */
export async function createFromLink(ctx: CommandContext, linkpath: string, sourcePath: string): Promise<string | undefined> {
  const { host } = ctx;
  const path = newNotePath(linkpath, sourcePath);
  if (typeof path !== 'string') {
    host.notify('warn', t('links.create.notNote', linkpath));
    return undefined;
  }
  // A path above the vault root, or one with no name left, can never be created.
  if (path.split('/').some((seg) => seg === '..') || /(^|\/)\.md$/i.test(path)) {
    host.notify('warn', t('fileOps.name.invalid'));
    return undefined;
  }
  if (await host.fs.exists(path)) {
    host.notify('warn', t('fileOps.exists'));
    return undefined;
  }
  try {
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
  }
}
