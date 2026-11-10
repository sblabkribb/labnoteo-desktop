import { t } from '../i18n/t';
import type * as githubIpc from '../integrations/githubIpc';
import {
  githubErrorText,
  type Account,
  type DivergedFile,
  type GithubProgress,
  type InfoFinding,
  type PlanOutcome,
  type PlanTarget,
  type UploadChoices,
  type UploadOutcome,
  type Yellow,
} from '../integrations/githubIpc';
import type { ProgressHandle } from '../integrations/progressStore';
import type { CommandContext } from '../labnote/commands/context';
import type { ChoiceItem } from '../labnote/host/dialogStore';
import type { NotifyOpts } from '../labnote/host/toastStore';
import { formatBytes } from '../viewers/viewerStatus';
import { minutesOf } from './outcomeText';
import type { SignInResult } from './SignInDialog';
import { slugify } from './slug';
import type { Destination, DestinationInit } from './UploadDialog';

/** 준비된 계획(`github_plan` 의 `ready`). */
export type ReadyPlan = Extract<PlanOutcome, { outcome: 'ready' }>;

/** 미리보기 머리에 보일 것: 실험 제목, 올릴 저장소, 비공개인지. */
export interface PreviewHead {
  title: string;
  fullName?: string;
  private?: boolean;
}

/** 첫 올리기가 끝났을 때 보일 것(spec §5.6). */
export interface DoneResult {
  title: string;
  fullName: string;
  htmlUrl: string;
}

/** 바뀐 파일 화면의 답. `ack` 는 확인한 파일 경로. */
export interface DivergedAnswer {
  mode: 'mine' | 'separate';
  ack: string[];
}

/** 흐름이 부르는 GitHub 커맨드(`githubIpc` 의 것 그대로). */
export type FlowIpc = Pick<
  typeof githubIpc,
  'githubAccount' | 'githubSignOut' | 'githubFolderStatus' | 'githubDefaultOwnerGet' | 'githubPlan' | 'githubUpload' | 'onGithubProgress'
>;

/** 흐름이 여는 화면. 앱에서는 대화상자 줄(dialogStore), 진행 창, 알림이다. */
export interface FlowUi {
  signIn(): Promise<SignInResult>;
  destination(init: DestinationInit): Promise<Destination | 'cancel'>;
  preview(plan: ReadyPlan, head: PreviewHead): Promise<UploadChoices | 'cancel'>;
  quick(plan: ReadyPlan): Promise<'upload' | 'details' | 'cancel'>;
  diverged(files: DivergedFile[]): Promise<DivergedAnswer | 'cancel'>;
  progress(title: string): ProgressHandle;
  notify(kind: 'info' | 'warn' | 'error', message: string, opts?: NotifyOpts): void;
  choose<T>(message: string, choices: readonly ChoiceItem<T>[], opts?: { title?: string }): Promise<T | undefined>;
  done(result: DoneResult): Promise<void>;
  openExternal(url: string): Promise<unknown> | void;
  openSettings(page: 'integrations', opts?: { focus?: 'githubToken' }): Promise<void> | void;
}

/** 노트에서 모은 것(P-R3, P-R4): 시료 ID, 표시용 발견, 실험 제목. */
export interface CollectedInfo {
  sampleIds: string[];
  infoFindings: InfoFinding[];
  title: string;
}

export interface FlowDeps {
  ipc: FlowIpc;
  ui: FlowUi;
  collectInfo(folder: string): Promise<CollectedInfo>;
  /** 저장소 이름의 비상용 꼬리(`labnote-YYYYMMDD-xxxx`). 기본은 무작위 4자. */
  rand?: () => string;
  today?: () => Date;
}

function randomTail(): string {
  const a = new Uint8Array(2);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function basename(folder: string): string {
  return folder.slice(folder.lastIndexOf('/') + 1);
}

/**
 * 파일마다의 확인 거리 가운데 바뀌지 않은 파일의 것은 짧은 확인을 막지 않는다(Rust `quick_ok` 와 같은 규칙):
 * 큰 파일·이름 방식·GPS·검사 못 한 파일은 이번에 바뀌는 파일에 걸릴 때만, 그 밖의 것은 언제나 막는다.
 */
export function yellowBlocksQuick(plan: ReadyPlan): boolean {
  const changed = new Set(plan.files.filter((f) => f.change !== 'same').map((f) => f.path));
  const touches = (paths: string[]) => paths.some((p) => changed.has(p));
  return plan.yellow.some((y: Yellow) => {
    switch (y.kind) {
      case 'large':
      case 'nfd':
        return changed.has(y.path);
      case 'gps':
      case 'unscanned':
        return touches(y.paths);
      default:
        return true;
    }
  });
}

/** 짧은 확인(spec §5.4): 다시 올리기에서 새 파일이나 지울 파일만 있고, 막는 것도 확인할 것도 없을 때. */
export function fitsQuick(plan: ReadyPlan): boolean {
  return (
    plan.mode === 'update' &&
    plan.red.length === 0 &&
    plan.samples.length === 0 &&
    !yellowBlocksQuick(plan) &&
    (plan.totals.new > 0 || plan.totals.deleted > 0)
  );
}

/** 계획을 세우지 못한 까닭의 글. */
function planProblemText(plan: Exclude<PlanOutcome, { outcome: 'ready' }>): string {
  switch (plan.outcome) {
    case 'folderHasGit':
      return t('github.err.folderHasGit');
    case 'badPath':
      return t('github.err.badPath', plan.paths.join(', '));
    case 'notExperiment':
    case 'notLinked':
      return t('github.err.local');
  }
}

/** 진행 이벤트를 진행 창의 줄로: 단계가 바뀔 때 한 줄, 올리기는 끝났을 때 한 줄 더. */
function progressLines(p: ProgressHandle): (e: GithubProgress) => void {
  let stage: GithubProgress['stage'] | undefined;
  let finished = false;
  return (e) => {
    const size = (n: number) => formatBytes(n, t);
    if (e.stage !== stage) {
      stage = e.stage;
      if (e.stage === 'uploading') {
        p.line(t('github.progress.noCancel'));
        p.line(t('github.progress.uploading', size(e.done), size(e.total)));
        finished = e.total > 0 && e.done >= e.total;
      } else {
        p.line(e.stage === 'creating' ? t('github.progress.creating') : e.stage === 'preparing' ? t('github.progress.preparing') : t('github.progress.checking'));
      }
      return;
    }
    if (e.stage === 'uploading' && !finished && e.total > 0 && e.done >= e.total) {
      finished = true;
      p.line(t('github.progress.uploading', size(e.done), size(e.total)));
    }
  };
}

type Next = 'stop' | 'plan' | 'destination';

/**
 * 실험 폴더 하나를 GitHub 에 올린다(spec §5): 계정 → (연결 안 된 폴더면) 올릴 곳 → 계획 → 확인 → 올리기 → 결과.
 * - 계정이 없으면 로그인. "토큰으로 연결" 은 흐름을 끝내고 설정을 연다(설정 창은 다른 대화상자 위에 뜰 수 없다).
 * - 계획이 `quickOk` 면 묻지 않고 올린다. 새 파일·지울 파일만 있으면 짧은 확인, 그 밖에는 전체 미리보기.
 * - `needsSignIn` 은 한 번만 다시 로그인하고 다시 계획한다. `planStale`·`planExpired` 도 한 번만 다시 계획한다.
 * - `diverged` 는 바뀐 파일 화면을 보이고 같은 계획을 그 답과 함께 다시 올린다.
 * - 어떤 결과도 저절로 다시 시도하지 않는다(`rateLimited`, `busy`, `visibilityMismatch` …).
 * - 올리는 동안 진행 창은 취소할 수 없다: Rust 의 올리기는 시작하면 끝까지 간다(spec §5.5).
 */
export async function uploadExperiment(ctx: CommandContext, folder: string, deps: FlowDeps): Promise<void> {
  void ctx;
  try {
    await runFlow(folder, deps);
  } catch (e) {
    const text = githubErrorText(e);
    if (text) deps.ui.notify('error', text);
  }
}

async function signIn(deps: FlowDeps): Promise<Account | null> {
  const r = await deps.ui.signIn();
  if (r === 'useToken') {
    await deps.ui.openSettings('integrations', { focus: 'githubToken' });
    return null;
  }
  if (r !== 'ok') return null;
  return deps.ipc.githubAccount();
}

async function runFlow(folder: string, deps: FlowDeps): Promise<void> {
  const { ipc, ui } = deps;
  let account = await ipc.githubAccount();
  if (!account) {
    account = await signIn(deps);
    if (!account) return;
  }
  const info = await deps.collectInfo(folder);
  const status = await ipc.githubFolderStatus(folder);
  const slug = slugify(basename(folder), (deps.today ?? (() => new Date()))(), deps.rand ?? randomTail);
  const first = !status.linked;
  let target: PlanTarget = { kind: 'update' };
  let publicConfirm: string | undefined;
  let head: PreviewHead = { title: info.title, fullName: status.fullName, private: status.private };
  let preset: Partial<Pick<DestinationInit, 'owner' | 'mode'>> = {};

  const chooseDestination = async (): Promise<boolean> => {
    for (;;) {
      const me: Account = account!;
      let defaultOwner: string | undefined;
      try {
        defaultOwner = (await ipc.githubDefaultOwnerGet()) ?? undefined;
      } catch {
        defaultOwner = undefined;
      }
      const d = await ui.destination({ title: info.title, folderName: basename(folder), account: me, slug, defaultOwner, ...preset });
      preset = {};
      if (d === 'cancel') return false;
      if (d.kind === 'switchAccount') {
        await ipc.githubSignOut();
        const again = await signIn(deps);
        if (!again) return false;
        account = again;
        continue;
      }
      target = d.kind === 'create' ? { kind: 'create', owner: d.owner, name: d.name, private: d.private } : { kind: 'link', owner: d.owner, name: d.name };
      publicConfirm = d.publicConfirm;
      head = { title: info.title, fullName: `${d.owner}/${d.name}`, private: d.kind === 'create' ? d.private : publicConfirm === undefined };
      return true;
    }
  };

  if (first && !(await chooseDestination())) return;

  let signedInAgain = false;
  let replanned = false;
  for (;;) {
    const plan = await ipc.githubPlan({
      folder,
      target,
      sampleIds: info.sampleIds,
      // 다시 올리기에서는 링크 같은 표시용 발견을 다시 보이지 않는다: 처음 올릴 때 보였고, 넘기면 매번 전체 미리보기가 된다.
      infoFindings: target.kind === 'update' ? [] : info.infoFindings,
    });
    if (plan.outcome !== 'ready') {
      if (plan.outcome === 'notLinked' && !replanned) {
        replanned = true;
        if (!(await chooseDestination())) return;
        continue;
      }
      ui.notify('error', planProblemText(plan));
      return;
    }
    const choices = await review(plan, head, ui);
    if (!choices) return;
    const base: UploadChoices = publicConfirm !== undefined ? { ...choices, publicConfirm } : choices;
    let outcome = await upload(plan.planId, base, info.title, deps);
    while (outcome.outcome === 'diverged') {
      warnNowPublic(outcome.warnings, ui);
      const answer = await ui.diverged(outcome.files);
      if (answer === 'cancel') return;
      outcome = await upload(plan.planId, { ...base, diverged: answer.mode, ackFiles: answer.ack }, info.title, deps);
    }
    const next: Next = await (async (): Promise<Next> => {
      switch (outcome.outcome) {
        case 'done':
          warnNowPublic(outcome.warnings, ui);
          if (first && plan.mode === 'first') {
            await ui.done({ title: info.title, fullName: outcome.fullName, htmlUrl: outcome.htmlUrl });
          } else {
            const c = outcome.counts;
            const url = outcome.htmlUrl;
            ui.notify('info', t('github.done.changes', c.new, c.changed, c.deleted, info.title), {
              action: { label: t('github.menu.open'), run: () => void ui.openExternal(url) },
            });
          }
          return 'stop';
        case 'nothingChanged':
          ui.notify('info', t('github.done.nothing'));
          return 'stop';
        case 'pushedSeparately': {
          warnNowPublic(outcome.warnings, ui);
          const url = outcome.compareUrl;
          ui.notify('info', t('github.diverged.compare'), { action: { label: t('github.menu.open'), run: () => void ui.openExternal(url) } });
          return 'stop';
        }
        case 'needsSignIn':
          if (signedInAgain) {
            ui.notify('error', t('github.err.needsSignIn'));
            return 'stop';
          }
          signedInAgain = true;
          account = await signIn(deps);
          return account ? 'plan' : 'stop';
        case 'planStale':
        case 'planExpired':
        case 'blocked':
          if (replanned) {
            ui.notify('error', outcome.outcome === 'planExpired' ? t('github.err.planExpired') : t('github.err.planStale'));
            return 'stop';
          }
          replanned = true;
          if (outcome.outcome !== 'blocked') ui.notify('info', outcome.outcome === 'planExpired' ? t('github.err.planExpired') : t('github.err.planStale'));
          return 'plan';
        case 'needsPreview':
          // 저장소는 있다(끝나지 않은 올리기): 그 저장소로 다시 계획하고 미리보기를 보인다.
          if (replanned) {
            ui.notify('error', t('github.err.planStale'));
            return 'stop';
          }
          replanned = true;
          target = { kind: 'update' };
          head = { ...head, fullName: outcome.fullName };
          return 'plan';
        case 'orgRestricted': {
          const way = await ui.choose(
            t('github.err.orgRestricted', outcome.org),
            [
              { label: t('github.err.orgMine'), value: 'mine' as const },
              { label: t('github.err.orgRequest'), value: 'request' as const },
              { label: t('github.err.orgAskAdmin'), value: 'link' as const },
            ],
          );
          if (way === 'request') {
            await ui.openExternal(outcome.approveUrl);
            return 'stop';
          }
          if (way === 'mine') preset = { owner: account?.login };
          else if (way === 'link') preset = { mode: 'link' };
          else return 'stop';
          return 'destination';
        }
        case 'ssoRequired': {
          const url = outcome.url;
          const go = await ui.choose(t('github.err.sso'), [{ label: t('github.err.ssoOpen'), value: true }]);
          if (go) await ui.openExternal(url);
          return 'stop';
        }
        case 'cannotCreateInOrg': {
          const mine = await ui.choose(t('github.err.cannotCreate'), [{ label: t('github.err.orgMine'), value: true }]);
          if (!mine) return 'stop';
          preset = { owner: account?.login };
          return 'destination';
        }
        case 'nameTaken':
          ui.notify('warn', t('github.dest.taken'));
          {
            // 올릴 곳은 대화상자 안에서 다시 정해진다: 흐름 분석이 그 대입을 못 보므로 넓혀 읽는다.
            const tg = target as PlanTarget;
            preset = tg.kind === 'update' ? {} : { owner: tg.owner };
          }
          return 'destination';
        case 'visibilityMismatch': {
          const url = outcome.htmlUrl;
          const go = await ui.choose(t('github.err.visibilityMismatch'), [{ label: t('github.menu.open'), value: true }]);
          if (go) await ui.openExternal(url);
          return 'stop';
        }
        case 'notFoundOrNoAccess':
          ui.notify('error', t('github.err.notFound'));
          return 'stop';
        case 'readOnly':
          ui.notify('error', t('github.err.readOnly'));
          return 'stop';
        case 'rateLimited':
          ui.notify('error', t('github.err.rateLimited', minutesOf(outcome.seconds)));
          return 'stop';
        case 'rejected': {
          const lead = outcome.kind === 'secretDetected' ? t('github.err.secretByGithub') : t('github.err.rejected');
          ui.notify('error', lead, outcome.lines.length > 0 ? { title: lead, detail: outcome.lines.join('\n') } : undefined);
          return 'stop';
        }
        case 'legalBlock':
          ui.notify('error', t('github.err.legal', outcome.message));
          return 'stop';
        case 'busy':
          ui.notify('warn', t('github.err.busy'));
          return 'stop';
      }
    })();
    if (next === 'stop') return;
    if (next === 'destination') {
      if (!(await chooseDestination())) return;
    }
  }
}

function warnNowPublic(warnings: readonly string[], ui: FlowUi): void {
  if (warnings.includes('nowPublic')) ui.notify('warn', t('github.public.nowPublic'));
}

/** 계획을 보이고 고른 것을 받는다. 닫으면 null. */
async function review(plan: ReadyPlan, head: PreviewHead, ui: FlowUi): Promise<UploadChoices | null> {
  if (plan.quickOk) return {};
  if (fitsQuick(plan)) {
    const q = await ui.quick(plan);
    if (q === 'cancel') return null;
    if (q === 'upload') return {};
  }
  const c = await ui.preview(plan, head);
  return c === 'cancel' ? null : c;
}

/** 진행 창을 띄우고 올린다. 진행 창은 처음부터 취소할 수 없다(Rust 의 올리기는 멈추지 않는다). */
async function upload(planId: string, choices: UploadChoices, title: string, deps: FlowDeps): Promise<UploadOutcome> {
  const p = deps.ui.progress(t('github.dest.title', title));
  p.setCancellable(false);
  const requestId = crypto.randomUUID();
  const onLine = progressLines(p);
  let unlisten: () => void = () => undefined;
  try {
    unlisten = await deps.ipc.onGithubProgress((e) => {
      if (e.requestId === requestId) onLine(e);
    });
  } catch {
    // 진행 줄이 없어도 올리기는 된다.
  }
  try {
    return await deps.ipc.githubUpload({ planId, choices, requestId });
  } finally {
    unlisten();
    p.done();
  }
}
