import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { listen as tauriListen } from '@tauri-apps/api/event';
import { t } from '../i18n/t';
import { toNetError, trackRequest, type InvokeFn, type ListenFn } from './netIpc';

/**
 * GitHub 커맨드(`github_*`)의 타입 있는 래퍼. GitHub 와 Git 은 모두 Rust 가 한다: 토큰은 Windows 자격 증명
 * 관리자에만 있고 웹뷰로 돌아오지 않는다. 웹뷰가 토큰을 Rust 에 넘기는 길은 `githubSetToken`(토큰 붙여넣기) 하나다.
 *
 * 타입은 Rust 의 serde 모양을 그대로 옮긴다(`#[serde(tag = "outcome", rename_all = "camelCase")]` 등).
 * 거절은 `netIpc` 와 같이 `NetError` 다. 사용자에게 보이는 글은 `githubErrorText` 가 `kind` 에서 만든다.
 */

/** invoke 를 부르고, 거절은 `NetError` 로 바꾼다. */
async function call<T>(invoke: InvokeFn, cmd: string, args: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    throw toNetError(e);
  }
}

// ── 타입(Rust 와 같은 모양) ─────────────────────────────────────────

/** Rust `Account`: 연결된 계정(비밀이 아니다). */
export interface Account {
  login: string;
  id: number;
  avatarUrl: string;
}

/** Rust `SignInStart`. */
export type SignInStart =
  | { outcome: 'started'; userCode: string; verificationUri: string; expiresIn: number }
  | { outcome: 'notConfigured' }
  | { outcome: 'appMisconfigured' };

/** Rust `SignInOutcome`. */
export type SignInOutcome =
  | { outcome: 'signedIn'; login: string; id: number; avatarUrl: string }
  | { outcome: 'expired' }
  | { outcome: 'denied' }
  | { outcome: 'appMisconfigured' }
  | { outcome: 'scopeMissing' }
  | { outcome: 'cancelled' };

/** Rust `TokenOutcome`. */
export type TokenOutcome =
  | { outcome: 'saved'; login: string; fineGrained: boolean }
  | { outcome: 'badToken' }
  | { outcome: 'needsSignIn' }
  | { outcome: 'scopeMissing' };

/** Rust `GithubAppSettingsView`: 앱 전체 설정. `clientId` 는 직접 넣은 값이 있을 때만 있다. */
export interface GithubAppSettings {
  clientId?: string;
  clientIdDefault: boolean;
  forgetOnExit: boolean;
}

/** Rust `GithubAppSettingsPatch`. `clientId: null` 은 기본값으로 되돌린다. 없는 필드는 바꾸지 않는다. */
export interface GithubAppSettingsPatch {
  clientId?: string | null;
  forgetOnExit?: boolean;
}

/** Rust `ApiOutcome`: GitHub 답의 뜻(spec §7.2). */
export type ApiOutcome =
  | { outcome: 'ok' }
  | { outcome: 'needsSignIn' }
  | { outcome: 'orgRestricted'; org: string }
  | { outcome: 'ssoRequired'; url: string }
  | { outcome: 'cannotCreateInOrg'; org: string }
  | { outcome: 'rateLimited'; seconds: number }
  | { outcome: 'nameTaken' }
  | { outcome: 'notFoundOrNoAccess' }
  | { outcome: 'moved'; location: string }
  | { outcome: 'legalBlock'; message: string }
  | { outcome: 'other'; status: number };

/** 성공 말고의 `ApiOutcome`(결과 열거형에 `#[serde(untagged)]` 로 붙는다). */
export type ApiFailure = Exclude<ApiOutcome, { outcome: 'ok' }>;

/** Rust `Owner`. */
export interface Owner {
  login: string;
  kind: 'user' | 'org';
}

/** Rust `OwnersOutcome`: 내 계정이 먼저, 그다음 조직. 세분화 토큰이면 `orgsListed` 가 false 다. */
export type OwnersOutcome = { outcome: 'ok'; owners: Owner[]; orgsListed: boolean } | ApiFailure;

/** Rust `NameCheck`. */
export type NameCheck =
  | { outcome: 'free' }
  | { outcome: 'taken'; repoId: number; empty: boolean; private: boolean; canPush: boolean }
  | { outcome: 'invalidName' }
  | ApiFailure;

/** Rust `ResolveOutcome`. */
export type ResolveOutcome =
  | {
      outcome: 'ok';
      owner: string;
      name: string;
      repoId: number;
      private: boolean;
      empty: boolean;
      canPush: boolean;
      defaultBranch: string;
    }
  | { outcome: 'invalidUrl' }
  | ApiFailure;

/** Rust `PlanTarget`. */
export type PlanTarget =
  | { kind: 'create'; owner: string; name: string; private: boolean }
  | { kind: 'link'; owner: string; name: string }
  | { kind: 'update' };

/** Rust `InfoKind`: 웹뷰가 넘기는 표시용 발견(P-R4). */
export type InfoKind = 'author' | 'crossLinks' | 'wikiLinks' | 'unused' | 'outside';

/** `github_plan` 의 `infoFindings` 한 줄. Rust 가 다시 다듬고, 파일 목록에는 아무것도 더하지 못한다. */
export interface InfoFinding {
  kind: InfoKind;
  count?: number;
  paths?: string[];
  names?: string[];
}

export type PlanMode = 'first' | 'update';
export type Change = 'new' | 'changed' | 'deleted' | 'same';

/** Rust `PlanFile`: 미리보기의 한 줄. */
export interface PlanFile {
  path: string;
  size: number;
  change: Change;
  generated?: boolean;
  sample?: boolean;
}

/** Rust `ExcludeReason`. */
export type ExcludeReason = 'hard' | 'user' | 'tooLarge' | 'link';

/** Rust `PlanExcluded`. */
export interface PlanExcluded {
  path: string;
  reason: ExcludeReason;
}

/** Rust `SavedLabel`: 앱에 저장한 키 중 어느 것인지. */
export type SavedLabel = 'llm' | 'partbank' | 'bfw' | 'slack' | 'github' | 'mcp';

/** Rust `HitKind`(`tag = "kind", content = "label"`, `Hit` 에 펼쳐진다). */
export type HitKind =
  | { kind: 'apiKey' }
  | { kind: 'privateKey' }
  | { kind: 'password' }
  | { kind: 'token' }
  | { kind: 'suspect' }
  | { kind: 'saved'; label: SavedLabel };

/** Rust `Hit`: 비밀 검사 한 건. 값은 `masked` 로만 온다. */
export type Hit = HitKind & {
  path: string;
  line: number;
  masked: string;
  lineHash: string;
  overridable: boolean;
};

/** Rust `Red`: 올리기를 막는 것. */
export type Red =
  | { kind: 'secret'; hit: Hit; fromSample?: boolean }
  | { kind: 'tooLarge'; path: string; size: number }
  | { kind: 'uploadTooLarge'; total: number; limit: number }
  | { kind: 'nfdCollision'; paths: string[] }
  | { kind: 'unreadable'; path: string }
  | { kind: 'publicNotConfirmed' }
  | { kind: 'divergedNotAcknowledged'; paths: string[] };

/** Rust `Yellow`: 확인해 볼 것(막지 않는다). */
export type Yellow =
  | { kind: 'large'; path: string; size: number }
  | { kind: 'repoLarge'; total: number }
  | { kind: 'nfd'; path: string }
  | { kind: 'gps'; paths: string[] }
  | { kind: 'unscanned'; paths: string[] }
  | { kind: 'vaultIsGit' }
  | { kind: 'excludedLink'; path: string }
  | { kind: 'info'; info: InfoKind; count: number; paths: string[]; names: string[] };

/** Rust `SampleSummary`. */
export interface SampleSummary {
  id: string;
  type: string;
  name: string;
}

/** Rust `Totals`. */
export interface Totals {
  files: number;
  generated: number;
  bytes: number;
  excluded: number;
  new: number;
  changed: number;
  deleted: number;
}

/** Rust `PlanOutcome`. 웹뷰는 `planId` 손잡이만 들고, 파일 목록은 Rust 가 쥔다. */
export type PlanOutcome =
  | {
      outcome: 'ready';
      planId: string;
      mode: PlanMode;
      files: PlanFile[];
      excluded: PlanExcluded[];
      red: Red[];
      yellow: Yellow[];
      samples: SampleSummary[];
      totals: Totals;
      quickOk: boolean;
    }
  | { outcome: 'folderHasGit' }
  | { outcome: 'notExperiment' }
  | { outcome: 'notLinked' }
  | { outcome: 'badPath'; paths: string[] };

/** Rust `AllowedHit`: "키가 아닙니다" 한 건. */
export interface AllowedHit {
  path: string;
  lineHash: string;
}

/**
 * Rust `UploadChoices`(`deny_unknown_fields`). 웹뷰는 Rust 가 적은 것을 빼거나(`untick`) 확인할(`allowHits`)
 * 수만 있고, 파일을 더할 수는 없다.
 */
export interface UploadChoices {
  untick?: string[];
  allowHits?: AllowedHit[];
  publicConfirm?: string | null;
  includeSamples?: boolean;
  diverged?: 'mine' | 'separate' | null;
  ackFiles?: string[];
}

/** Rust `Counts`. */
export interface Counts {
  new: number;
  changed: number;
  deleted: number;
}

export type UploadWarning = 'nowPublic';
export type RejectKind = 'secretDetected' | 'emailPrivacy' | 'protectedBranch' | 'nonFastForward' | 'other';

/** Rust `DivergedFile`. */
export interface DivergedFile {
  path: string;
  change: Change;
  goneHere: boolean;
}

/** Rust `UploadOutcome`(`github_upload`, `github_retry`). */
export type UploadOutcome =
  | { outcome: 'done'; htmlUrl: string; fullName: string; counts: Counts; warnings: UploadWarning[] }
  | { outcome: 'nothingChanged' }
  | { outcome: 'needsSignIn' }
  | { outcome: 'blocked'; red: Red[] }
  | { outcome: 'planStale' }
  | { outcome: 'planExpired' }
  | { outcome: 'diverged'; files: DivergedFile[]; warnings: UploadWarning[] }
  | { outcome: 'pushedSeparately'; compareUrl: string; warnings: UploadWarning[] }
  | { outcome: 'orgRestricted'; org: string; approveUrl: string }
  | { outcome: 'ssoRequired'; url: string }
  | { outcome: 'cannotCreateInOrg'; org: string }
  | { outcome: 'nameTaken' }
  | { outcome: 'notFoundOrNoAccess' }
  | { outcome: 'readOnly' }
  | { outcome: 'rateLimited'; seconds: number }
  | { outcome: 'rejected'; kind: RejectKind; lines: string[] }
  | { outcome: 'legalBlock'; message: string }
  | { outcome: 'visibilityMismatch'; htmlUrl: string }
  | { outcome: 'busy' }
  | { outcome: 'needsPreview'; fullName: string; htmlUrl: string };

/** Rust `LinkState`: 올리기 기록의 단계. */
export type LinkState = 'planned' | 'repoCreating' | 'repoReady' | 'committed' | 'pushed';

/** Rust `FolderStatus`. 네트워크 없이 만든다. */
export interface FolderStatus {
  linked: boolean;
  private?: boolean;
  state: LinkState;
  changedCount: number;
  lastPushedAt?: number;
  fullName?: string;
  htmlUrl?: string;
  folderMissing: boolean;
}

/** Rust `Stage`. */
export type ProgressStage = 'creating' | 'preparing' | 'uploading' | 'checking';

/** `github://progress` 의 모양(`src-tauri/tests/ipc-events.json`). */
export interface GithubProgress {
  requestId: string;
  stage: ProgressStage;
  done: number;
  total: number;
}

// ── 로그인과 계정 ─────────────────────────────────────────────────

/** 기기 코드 로그인을 시작한다. client ID 가 없으면 `notConfigured`(네트워크를 쓰지 않는다). */
export function githubSignInStart(invoke: InvokeFn = tauriInvoke): Promise<SignInStart> {
  return call<SignInStart>(invoke, 'github_sign_in_start', {});
}

/** 사용자가 코드를 넣을 때까지 기다린다. `signal` 이 끊기면 `net_cancel` 을 보내고 `cancelled` 로 거절한다. */
export function githubSignInWait(a: { signal?: AbortSignal }, invoke: InvokeFn = tauriInvoke): Promise<SignInOutcome> {
  return trackRequest(a.signal, (requestId) => call<SignInOutcome>(invoke, 'github_sign_in_wait', { requestId }), invoke);
}

/** 연결된 계정, 없으면 null. 네트워크를 쓰지 않는다. */
export function githubAccount(invoke: InvokeFn = tauriInvoke): Promise<Account | null> {
  return call<Account | null>(invoke, 'github_account', {});
}

/** 로그아웃: 자격 증명 관리자의 두 자리와 계정 기록을 지운다. 네트워크를 쓰지 않는다. */
export async function githubSignOut(invoke: InvokeFn = tauriInvoke): Promise<void> {
  await call<null>(invoke, 'github_sign_out', {});
}

/** 토큰 붙여넣기(고급). 토큰을 Rust 로 넘기는 유일한 래퍼다. 거절 글에는 값이 들어가지 않는다. */
export async function githubSetToken(value: string, invoke: InvokeFn = tauriInvoke): Promise<TokenOutcome> {
  try {
    return await invoke<TokenOutcome>('github_set_token', { value });
  } catch (e) {
    const err = toNetError(e);
    if (value && (err.message.includes(value) || (err.body ?? '').includes(value))) {
      throw toNetError({ kind: err.kind, message: err.message.split(value).join('***'), status: err.status });
    }
    throw err;
  }
}

// ── 앱 전체 설정 ──────────────────────────────────────────────────

export function githubAppSettingsGet(invoke: InvokeFn = tauriInvoke): Promise<GithubAppSettings> {
  return call<GithubAppSettings>(invoke, 'github_app_settings_get', {});
}

/** client ID 가 바뀌면 Rust 가 먼저 로그아웃한다(토큰은 그 앱의 것이다). */
export function githubAppSettingsSet(patch: GithubAppSettingsPatch, invoke: InvokeFn = tauriInvoke): Promise<GithubAppSettings> {
  return call<GithubAppSettings>(invoke, 'github_app_settings_set', { patch });
}

// ── 올릴 곳 ───────────────────────────────────────────────────────

/** 올릴 수 있는 곳(내 계정, 조직). `signal` 로 취소한다. */
export function githubOwners(a: { signal?: AbortSignal }, invoke: InvokeFn = tauriInvoke): Promise<OwnersOutcome> {
  return trackRequest(a.signal, (requestId) => call<OwnersOutcome>(invoke, 'github_owners', { requestId }), invoke);
}

/** `owner/name` 이 비어 있는지. 쓸 수 없는 이름은 아무것도 보내지 않고 `invalidName`. */
export function githubNameCheck(owner: string, name: string, invoke: InvokeFn = tauriInvoke): Promise<NameCheck> {
  return call<NameCheck>(invoke, 'github_name_check', { owner, name });
}

/** 붙여 넣은 저장소 주소(또는 `owner/name`)를 확인한다. GitHub 주소가 아니면 아무것도 보내지 않는다. */
export function githubResolveRepo(url: string, invoke: InvokeFn = tauriInvoke): Promise<ResolveOutcome> {
  return call<ResolveOutcome>(invoke, 'github_resolve_repo', { url });
}

export function githubDefaultOwnerGet(invoke: InvokeFn = tauriInvoke): Promise<string | null> {
  return call<string | null>(invoke, 'github_default_owner_get', {});
}

export async function githubDefaultOwnerSet(owner: string, invoke: InvokeFn = tauriInvoke): Promise<void> {
  await call<null>(invoke, 'github_default_owner_set', { owner });
}

// ── 계획과 올리기 ─────────────────────────────────────────────────

/** 올릴 파일을 확인한다. 네트워크를 쓰지 않는다. 표시용 발견과 시료 ID 는 파일 목록에 아무것도 더하지 못한다. */
export function githubPlan(
  a: { folder: string; target: PlanTarget; sampleIds: string[]; infoFindings: InfoFinding[] },
  invoke: InvokeFn = tauriInvoke,
): Promise<PlanOutcome> {
  return call<PlanOutcome>(invoke, 'github_plan', {
    folder: a.folder,
    target: a.target,
    sampleIds: a.sampleIds,
    infoFindings: a.infoFindings,
  });
}

function newRequestId(given: string | undefined): string {
  return given ?? crypto.randomUUID();
}

/**
 * 계획대로 올린다. 올리는 중에는 취소할 수 없다: 보관함을 바꿔도 `net_cancel` 을 보내지 않는다.
 * 진행 이벤트(`onGithubProgress`)를 이 올리기 것만 고르려면 `requestId` 를 직접 정해 넘긴다.
 */
export function githubUpload(
  a: { planId: string; choices: UploadChoices; requestId?: string },
  invoke: InvokeFn = tauriInvoke,
): Promise<UploadOutcome> {
  return call<UploadOutcome>(invoke, 'github_upload', {
    requestId: newRequestId(a.requestId),
    planId: a.planId,
    choices: a.choices,
  });
}

/** 끝나지 않은 올리기를 마저 한다(같은 이름의 저장소를 두 번 만들지 않는다). */
export function githubRetry(a: { folder: string; requestId?: string }, invoke: InvokeFn = tauriInvoke): Promise<UploadOutcome> {
  return call<UploadOutcome>(invoke, 'github_retry', { requestId: newRequestId(a.requestId), folder: a.folder });
}

// ── 상태와 연결 끊기(네트워크를 쓰지 않는다) ─────────────────────────

export function githubFolderStatus(folder: string, invoke: InvokeFn = tauriInvoke): Promise<FolderStatus> {
  return call<FolderStatus>(invoke, 'github_folder_status', { folder });
}

/** 연결된 폴더마다의 상태(폴더 → 상태). */
export function githubStatuses(invoke: InvokeFn = tauriInvoke): Promise<Record<string, FolderStatus>> {
  return call<Record<string, FolderStatus>>(invoke, 'github_statuses', {});
}

/** 폴더의 연결만 잊는다. GitHub 의 저장소는 그대로 남는다. */
export async function githubUnlink(folder: string, invoke: InvokeFn = tauriInvoke): Promise<void> {
  await call<null>(invoke, 'github_unlink', { folder });
}

// ── 진행 이벤트 ───────────────────────────────────────────────────

export const GITHUB_PROGRESS_EVENT = 'github://progress';

const STAGES: readonly ProgressStage[] = ['creating', 'preparing', 'uploading', 'checking'];

function isProgress(p: unknown): p is GithubProgress {
  if (!p || typeof p !== 'object') return false;
  const o = p as Record<string, unknown>;
  return (
    typeof o.requestId === 'string' &&
    typeof o.stage === 'string' &&
    (STAGES as readonly string[]).includes(o.stage) &&
    typeof o.done === 'number' &&
    typeof o.total === 'number'
  );
}

/** `github://progress` 를 듣는다. 모양이 틀린 것은 넘기지 않는다. 돌려준 함수로 구독을 푼다. */
export async function onGithubProgress(cb: (p: GithubProgress) => void, listen: ListenFn = tauriListen): Promise<() => void> {
  try {
    return await listen<unknown>(GITHUB_PROGRESS_EVENT, (e) => {
      if (isProgress(e.payload)) cb(e.payload);
    });
  } catch (e) {
    throw toNetError(e);
  }
}

// ── 오류 문장 ─────────────────────────────────────────────────────

/**
 * GitHub 커맨드가 거절했을 때 사용자에게 보일 문장. Rust 의 원래 글(`message`)은 쓰지 않는다.
 * 취소는 빈 글이다(아무것도 보이지 않는다).
 */
export function githubErrorText(e: unknown): string {
  const err = toNetError(e);
  switch (err.kind) {
    case 'cancelled':
      return '';
    case 'keyMissing':
      return t('github.err.needsSignIn');
    case 'status':
      return err.status === 401 ? t('github.err.needsSignIn') : t('github.err.apiLeg');
    case 'keychain':
      return t('github.err.keychain');
    case 'notConfigured':
      return t('github.err.noVault');
    case 'io':
    case 'badInput':
      return t('github.err.local');
    case 'offline':
    case 'timeout':
    case 'tls':
    case 'redirect':
    case 'notJson':
    case 'tooLarge':
    case 'remote':
    case 'noResult':
    case 'insecure':
    case 'invalidUrl':
    case 'forbiddenPath':
    // MCP 클라이언트·문헌·웹 검색의 종류: GitHub 커맨드는 내지 않지만 빠짐없이 같은 글로 둔다.
    case 'mcpAuth':
    case 'mcpProtocol':
    case 'mcpModernOnly':
    case 'mcpToolError':
    case 'jsonDisabled':
    case 'rateLimited':
    case 'enginesDown':
    case 'blocked':
    case 'unsupportedType':
      return t('github.err.apiLeg');
  }
}
