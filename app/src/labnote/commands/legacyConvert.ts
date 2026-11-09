/**
 * 예전(VS Code 시절) 실험 노트(`.md`)를 `.labnote.md` 로 바꾸기. 앱은 스스로 이름을 바꾸지 않는다: 보관함을 열 때 묻고
 * (legacyNotesOfferOnOpen), 사용자가 "바꾸기"를 고르거나 팔레트 명령(convertLegacyNotesCommand)을 돌릴 때만 바꾼다.
 * - 계획은 순수한 planLegacyLabnoteRenames(legacyNotes.ts)다. 바꿀 이름이 이미 있는 노트는 건너뛰고 알린다.
 * - 바꾸기는 파일 트리의 이름 바꾸기와 같은 길이다(SP4): 링크 잠금을 쥐고, 링크 색인을 기다리고, 열린 노트를 저장해 버퍼를
 *   색인에 내고, planRename 으로 다른 노트의 링크를 계산하고, renameWithLinks 로 기록(journal)을 남기며 바꾸고 링크를 고친다.
 *   그래서 끊긴 실행은 기존 기록 복구가 마치고, 열린 노트는 그 길이 하던 대로 닫았다 다시 연다.
 * - 하나씩 차례로 바꾸고 실패는 모아 둔다. 끝에 알림 하나로 알린다(바꾼 수, 건너뛴 충돌과 그 이름, 실패와 그 이유).
 */
import { parseRaw } from '../../editor/documentIo';
import { ERROR_KINDS, hasErrorKind } from '../../fs/errorKinds';
import { t } from '../../i18n/t';
import { IndexNotReadyError, planRename } from '../../links/planRename';
import { linkOps, renameWithLinks, type LinkSession, type RenameReport } from '../../links/renameWithLinks';
import { hasUnlinkableChars } from '../../links/resolve';
import { planLegacyLabnoteRenames, type LegacyRename } from '../legacyNotes';
import { openNote } from '../openNotes';
import type { CommandContext, LinkDeps } from './context';
import { failureLines, waitForLinks } from './fileOps';

type Choice = 'convert' | 'later' | 'never';
/** 이름을 바꾸지 못한 이유. 문구는 links.reason.* 를 다시 쓴다(exists, notReady 만 새것). */
type RenameFailReason = 'notSaved' | 'exists' | 'unsafeName' | 'notReady' | 'io';

const REASON_TEXT: Record<RenameFailReason, () => string> = {
  notSaved: () => t('links.reason.notSaved'),
  exists: () => t('legacy.reason.exists'),
  unsafeName: () => t('links.reason.unsafeName'),
  notReady: () => t('legacy.reason.notReady'),
  io: () => t('links.reason.io'),
};

const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1);

/** 제안 대화상자: 몇 개인지, 무엇을 하는지, 바꾸기 / 나중에 / 이 보관함에서는 다시 묻지 않기. */
async function ask(ctx: CommandContext, count: number): Promise<Choice | undefined> {
  return ctx.host.choose<Choice>(
    t('legacy.offer.body', count),
    [
      { label: t('legacy.offer.convert'), value: 'convert' },
      { label: t('legacy.offer.later'), value: 'later' },
      { label: t('legacy.offer.never'), value: 'never' },
    ],
    { title: t('legacy.offer.title') },
  );
}

/** 묻고, 고른 대로 한다. "다시 묻지 않기"는 보관함 설정에 남는다. */
async function offer(ctx: CommandContext, count: number): Promise<void> {
  const choice = await ask(ctx, count);
  if (choice === 'never') ctx.updateSettings({ legacyNotesOfferDismissed: true });
  else if (choice === 'convert') await convertLegacyNotes(ctx);
}

/**
 * 보관함을 열고 링크 색인이 준비된 뒤 한 번(App 이 부른다): 바꿀 예전 노트가 있고 "다시 묻지 않기"를 고른 적이 없으면 묻는다.
 * 던지지 않는다.
 */
export async function legacyNotesOfferOnOpen(ctx: CommandContext): Promise<void> {
  try {
    const links = ctx.links;
    if (ctx.settings.legacyNotesOfferDismissed || !links?.index.ready()) return;
    const plan = planLegacyLabnoteRenames(links.index.files());
    if (plan.renames.length === 0) return;
    await offer(ctx, plan.renames.length);
  } catch (e) {
    console.error('[labnote] legacy notes offer failed:', e);
  }
}

/** 팔레트 명령: "다시 묻지 않기"와 상관없이 같은 대화상자를 띄운다. 바꿀 것이 없으면 그렇게 알린다. */
export async function convertLegacyNotesCommand(ctx: CommandContext): Promise<void> {
  const links = ctx.links;
  if (!links || !(await waitForLinks(ctx, links))) {
    ctx.host.notify('warn', t('links.notReady'));
    return;
  }
  const plan = planLegacyLabnoteRenames(links.index.files());
  if (plan.renames.length === 0) {
    const lines = [t('legacy.none')];
    if (plan.conflicts.length > 0) lines.push(conflictLine(plan.conflicts));
    ctx.host.notify(plan.conflicts.length > 0 ? 'warn' : 'info', lines.join('\n\n'));
    return;
  }
  await offer(ctx, plan.renames.length);
}

const conflictLine = (conflicts: readonly LegacyRename[]) =>
  t('legacy.done.conflicts', conflicts.length, conflicts.map((c) => c.from).join('\n'));

/**
 * 계획을 다시 세우고(묻는 사이 바뀌었을 수 있다) 하나씩 바꾼다. 링크 잠금을 처음부터 끝까지 쥔다: 그동안 다른 이름 바꾸기,
 * 삭제, 명령은 거절된다(links.busy).
 */
export async function convertLegacyNotes(ctx: CommandContext): Promise<void> {
  const { host } = ctx;
  const links = ctx.links;
  if (!links) {
    host.notify('warn', t('links.notReady'));
    return;
  }
  const session = linkOps.claim();
  if (!session) {
    host.notify('warn', t('links.busy'));
    return;
  }
  try {
    if (!(await waitForLinks(ctx, links))) {
      host.notify('warn', t('links.notReady'));
      return;
    }
    const plan = planLegacyLabnoteRenames(links.index.files());
    let renamed = 0;
    const failed: Array<{ path: string; reason: RenameFailReason }> = [];
    const linkFailed: RenameReport['failed'] = [];
    for (const r of plan.renames) {
      const result = await renameOne(ctx, links, r, session);
      if ('reason' in result) failed.push({ path: r.from, reason: result.reason });
      else {
        renamed++;
        linkFailed.push(...result.report.failed);
      }
    }
    if (renamed > 0) ctx.refresh();

    const lines = [t('legacy.done', renamed)];
    if (plan.conflicts.length > 0) lines.push(conflictLine(plan.conflicts));
    if (failed.length > 0) {
      lines.push(t('legacy.done.failed', failed.length, failed.map((f) => `${f.path} (${REASON_TEXT[f.reason]()})`).join('\n')));
    }
    if (linkFailed.length > 0) lines.push(t('legacy.done.links', failureLines(linkFailed)));
    const clean = plan.conflicts.length === 0 && failed.length === 0 && linkFailed.length === 0;
    host.notify(clean ? 'info' : 'warn', lines.join('\n\n'));
  } finally {
    session.release();
  }
}

/** 하나를 파일 트리의 이름 바꾸기와 같은 길로 바꾸고, 다음 계획이 새 경로를 보도록 링크 색인을 맞춘다. */
async function renameOne(
  ctx: CommandContext,
  links: LinkDeps,
  r: LegacyRename,
  session: LinkSession,
): Promise<{ report: RenameReport } | { reason: RenameFailReason }> {
  const { host } = ctx;
  // 열린 노트를 저장하고 그 버퍼를 색인에 곧바로 낸다(D12 2)
  const active = ctx.activePath();
  const handle = active !== undefined ? openNote(active) : undefined;
  if (handle && !(await handle.flush())) return { reason: 'notSaved' };
  handle?.publishLinks();

  let plan;
  try {
    plan = await planRename({
      from: r.from,
      to: r.to,
      isDir: false,
      index: links.index,
      images: links.images,
      read: (p) => host.fs.read(p),
      search: links.search,
      activePath: active,
    });
  } catch (e) {
    if (e instanceof IndexNotReadyError) return { reason: 'notReady' };
    return { reason: 'io' };
  }
  if (plan.hasWikiRewrites && hasUnlinkableChars(baseName(r.to))) return { reason: 'unsafeName' };

  let report: RenameReport;
  try {
    report = await renameWithLinks(ctx, plan, links.journal, { session });
  } catch (e) {
    return { reason: hasErrorKind(e, ERROR_KINDS.exists) ? 'exists' : 'io' };
  }
  if (!report.renamed) return { reason: 'notSaved' };
  await syncIndex(ctx, links, r, report.updated);
  return { report };
}

/**
 * 감시자의 변경은 늦게 온다: 다음 노트의 계획이 옛 경로를 보지 않도록 바꾼 노트와 링크를 고친 노트를 지금 색인에 싣는다.
 * 감시자가 나중에 같은 파일을 다시 읽어도 결과는 같다.
 */
async function syncIndex(ctx: CommandContext, links: LinkDeps, r: LegacyRename, updated: readonly string[]): Promise<void> {
  links.index.removeTree(r.from);
  links.index.addFiles([r.to]);
  for (const p of [r.to, ...updated]) {
    try {
      links.index.setNote(p, parseRaw(p, await ctx.host.fs.read(p)).text);
    } catch {
      // 읽지 못한 노트는 감시자가 다시 읽는다
    }
  }
}
