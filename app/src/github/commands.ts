import { getExperimentDir } from '@labnoteo/core/lib/labnoteStructure';
import type { AppCommand } from '../editor/commands/appCommands';
import { t } from '../i18n/t';
import { githubErrorText, githubFolderStatus, githubRetry, githubUnlink } from '../integrations/githubIpc';
import type { CommandContext } from '../labnote/commands/context';
import { confirmDialog } from '../labnote/host/dialogStore';
import { MENU_SEPARATOR, type MenuAction, type MenuItem } from '../labnote/ui/menuStore';
import { openExternal, tauriExternalDeps } from '../links/openExternal';
import { finishExperiment, realFlowDeps, uploadExperiment } from './githubFlow';
import { forgetGithubStatus, githubStatusOf, isUnfinished, refreshGithubStatuses, statusKind } from './statusStore';

/** 열린 파일이 든 실험 폴더(옛 README.md 실험도). 실험 밖이면 undefined. */
export function activeExperiment(ctx: CommandContext): string | undefined {
  const path = ctx.activePath();
  return path ? getExperimentDir(path) : undefined;
}

/**
 * 실험 폴더 하나에 대한 GitHub 동작. 메뉴 항목과 명령이 같은 함수를 부른다(테스트는 이 객체를 엿본다).
 * 끝나면 상태 표시를 다시 읽는다.
 */
export const githubActions = {
  /** "GitHub에 올리기…" / "바뀐 내용 올리기": 한 흐름이다. */
  async upload(ctx: CommandContext, folder: string): Promise<void> {
    try {
      await uploadExperiment(ctx, folder, realFlowDeps(ctx));
    } finally {
      void refreshGithubStatuses();
    }
  },
  /** "GitHub에서 보기": 저장소 주소를 브라우저로 연다. */
  async open(ctx: CommandContext, folder: string): Promise<void> {
    const notify = (kind: 'info' | 'warn', message: string) => ctx.host.notify(kind, message);
    let url = githubStatusOf(folder)?.htmlUrl;
    if (!url) {
      try {
        url = (await githubFolderStatus(folder)).htmlUrl;
      } catch (e) {
        ctx.host.notify('error', githubErrorText(e) || t('github.err.local'));
        return;
      }
    }
    if (!url) {
      ctx.host.notify('error', t('github.err.notFound'));
      return;
    }
    await openExternal(url, tauriExternalDeps(notify));
  },
  /** "올리기 마저 하기": `github_retry` 로 멈춘 단계부터 잇는다. */
  async finish(ctx: CommandContext, folder: string): Promise<void> {
    try {
      await finishExperiment(ctx, folder, realFlowDeps(ctx), (a) => githubRetry(a));
    } finally {
      void refreshGithubStatuses();
    }
  },
  /** "GitHub 연결 끊기…": 묻고 나서 이 앱의 연결 기록만 지운다. GitHub 의 저장소는 그대로다. */
  async disconnect(ctx: CommandContext, folder: string): Promise<void> {
    const ok = await confirmDialog(t('github.unlink.confirm'), { confirmLabel: t('github.unlink.title'), destructive: true });
    if (!ok) return;
    try {
      await githubUnlink(folder);
      forgetGithubStatus(folder);
    } catch (e) {
      ctx.host.notify('error', githubErrorText(e) || t('github.err.local'));
    }
    void refreshGithubStatuses();
  },
};

/**
 * 실험 폴더 메뉴의 GitHub 구역(spec §5.1): 구분선 뒤, 첫 항목에 구역 이름. 연결 끊기는 위험 항목이고 맨 끝이다.
 * - 연결 없음: 올리기. 연결됨: 바뀐 내용 올리기, GitHub에서 보기, 연결 끊기. 끝나지 않음: 마저 하기(저장소가 있으면 보기도).
 * 실험 폴더 자체가 아니면 빈 목록이다.
 */
export function githubMenuItems(ctx: CommandContext, folder: string): MenuItem[] {
  if (getExperimentDir(folder) !== folder) return [];
  const status = githubStatusOf(folder);
  const kind = statusKind(status);
  const run = (action: keyof typeof githubActions) => () => githubActions[action](ctx, folder);
  const open: MenuAction = { labelKey: 'github.menu.open', icon: 'external-link', run: run('open') };
  const items: MenuAction[] =
    kind === undefined
      ? [{ labelKey: 'github.menu.upload', icon: 'upload', run: run('upload') }]
      : kind === 'unfinished'
        ? [{ labelKey: 'github.menu.finish', icon: 'refresh-cw', run: run('finish') }, ...(status?.htmlUrl ? [open] : [])]
        : [
            { labelKey: 'github.menu.uploadChanges', icon: 'cloud-upload', run: run('upload') },
            ...(status?.htmlUrl ? [open] : []),
            { labelKey: 'github.menu.unlink', icon: 'trash-2', danger: true, run: run('disconnect') },
          ];
  items[0] = { ...items[0], section: 'github.menu.section' };
  return [MENU_SEPARATOR, ...items];
}

/** 열린 파일의 실험에서 동작을 돌리는 명령. */
function onActive(action: keyof typeof githubActions) {
  return async (ctx: CommandContext) => {
    const folder = activeExperiment(ctx);
    if (folder) await githubActions[action](ctx, folder);
  };
}

const linkedOf = (ctx: CommandContext) => {
  const folder = activeExperiment(ctx);
  return folder === undefined ? undefined : { status: githubStatusOf(folder) };
};

/** 팔레트 명령(spec §5.1). 메뉴의 항목과 같은 동작을 열린 파일의 실험 폴더에 돌린다. */
export const githubAppCommands: AppCommand[] = [
  {
    id: 'github.uploadExperiment',
    nameKey: 'github.cmd.upload',
    icon: 'upload',
    available: (ctx) => activeExperiment(ctx) !== undefined,
    run: onActive('upload'),
  },
  {
    id: 'github.openOnGithub',
    nameKey: 'github.cmd.open',
    icon: 'external-link',
    available: (ctx) => {
      const s = linkedOf(ctx)?.status;
      return s?.linked === true && !!s.htmlUrl;
    },
    run: onActive('open'),
  },
  {
    id: 'github.finishUpload',
    nameKey: 'github.cmd.finish',
    icon: 'refresh-cw',
    available: (ctx) => isUnfinished(linkedOf(ctx)?.status),
    run: onActive('finish'),
  },
  {
    id: 'github.disconnect',
    nameKey: 'github.cmd.unlink',
    icon: 'trash-2',
    available: (ctx) => linkedOf(ctx)?.status?.linked === true,
    run: onActive('disconnect'),
  },
];
