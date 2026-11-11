import { readFileSync } from 'node:fs';
import { setLang } from '../../i18n/lang';
import { catalogs, t } from '../../i18n/t';
import * as gh from '../githubIpc';
import { NET_ERROR_KINDS, NetError, cancelAllRequests, type InvokeFn, type ListenFn } from '../netIpc';
import { netError } from './fakeNet';

/** 공유 픽스처(Rust tests/ipc.rs 도 읽는다). */
const ARGS: Record<string, string[]> = JSON.parse(readFileSync('src-tauri/tests/ipc-args.json', 'utf-8'));
const EVENTS = JSON.parse(readFileSync('src-tauri/tests/ipc-events.json', 'utf-8')) as Record<
  string,
  { name: string; payload: { fields: Record<string, string> } }
>;

/** 보낸 커맨드와 인자를 기록하는 가짜 invoke. */
function recorder(answers: Record<string, unknown> = {}) {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const invoke = (async (cmd: string, args: Record<string, unknown> = {}) => {
    calls.push([cmd, args]);
    return cmd in answers ? answers[cmd] : null;
  }) as InvokeFn;
  return { calls, invoke };
}

const FAKE_TOKEN = 'ghp_FAKE0000000000000000000000000000000000';
const PLAN_TARGET: gh.PlanTarget = { kind: 'create', owner: 'me', name: 'exp-1', private: true };

/** 래퍼 전부를 한 번씩 부른다. */
async function callEvery(invoke: InvokeFn): Promise<void> {
  await gh.githubSignInStart(invoke);
  await gh.githubSignInWait({}, invoke);
  await gh.githubAccount(invoke);
  await gh.githubSignOut(invoke);
  await gh.githubSetToken(FAKE_TOKEN, invoke);
  await gh.githubAppSettingsGet(invoke);
  await gh.githubAppSettingsSet({ forgetOnExit: true }, invoke);
  await gh.githubOwners({}, invoke);
  await gh.githubNameCheck('me', 'exp-1', invoke);
  await gh.githubResolveRepo('https://github.com/me/exp-1', invoke);
  await gh.githubPlan({ folder: 'labnote/001_A', target: PLAN_TARGET, sampleIds: [], infoFindings: [] }, invoke);
  await gh.githubUpload({ planId: 'p'.repeat(32), choices: {} }, invoke);
  await gh.githubRetry({ folder: 'labnote/001_A' }, invoke);
  await gh.githubFolderStatus('labnote/001_A', invoke);
  await gh.githubStatuses(invoke);
  await gh.githubDefaultOwnerGet(invoke);
  await gh.githubDefaultOwnerSet('lab', invoke);
  await gh.githubUnlink('labnote/001_A', invoke);
}

const GITHUB_COMMANDS = Object.keys(ARGS).filter((c) => c.startsWith('github_'));

describe('githubIpc wrappers', () => {
  it('every github_* command of the fixture has a wrapper that sends exactly its argument names', async () => {
    const r = recorder();
    await callEvery(r.invoke);
    const sent = Object.fromEntries(r.calls.map(([c, a]) => [c, Object.keys(a).sort()]));
    const expected = Object.fromEntries(GITHUB_COMMANDS.map((c) => [c, [...ARGS[c]].sort()]));
    expect(sent).toEqual(expected);
    expect(GITHUB_COMMANDS.length).toBe(18);
  });

  it('no wrapper takes a token except githubSetToken (runtime: argument names)', async () => {
    const r = recorder();
    await callEvery(r.invoke);
    for (const [cmd, args] of r.calls) {
      for (const name of Object.keys(args)) expect(name, cmd).not.toMatch(/token|secret|password|key/i);
      if (cmd !== 'github_set_token') expect(Object.keys(args), cmd).not.toContain('value');
      if (cmd !== 'github_set_token') expect(JSON.stringify(args), cmd).not.toContain(FAKE_TOKEN);
    }
    expect(r.calls.find(([c]) => c === 'github_set_token')?.[1]).toEqual({ value: FAKE_TOKEN });
    // 픽스처 자체도 같다: 값을 받는 github 커맨드는 github_set_token 하나다
    const takingValue = GITHUB_COMMANDS.filter((c) => ARGS[c].some((a) => /value|token|secret/i.test(a)));
    expect(takingValue).toEqual(['github_set_token']);
  });

  it('no wrapper takes a token except githubSetToken (type level)', () => {
    const invoke = recorder().invoke;
    // 부르지 않는다: tsc 가 아래 줄마다 오류를 내야 한다(@ts-expect-error 가 쓰이지 않으면 tsc 가 실패한다)
    const never = () => {
      // @ts-expect-error -- 토큰은 githubSetToken 으로만 간다
      void gh.githubOwners({ token: 'x' }, invoke);
      // @ts-expect-error -- 토큰은 githubSetToken 으로만 간다
      void gh.githubSignInWait({ token: 'x' }, invoke);
      // @ts-expect-error -- 토큰은 githubSetToken 으로만 간다
      void gh.githubUpload({ planId: 'p', choices: {}, token: 'x' }, invoke);
      // @ts-expect-error -- 토큰은 githubSetToken 으로만 간다
      void gh.githubRetry({ folder: 'f', token: 'x' }, invoke);
      // @ts-expect-error -- 토큰은 githubSetToken 으로만 간다
      void gh.githubPlan({ folder: 'f', target: PLAN_TARGET, sampleIds: [], infoFindings: [], token: 'x' }, invoke);
      // @ts-expect-error -- 앱 설정에도 토큰 자리가 없다
      void gh.githubAppSettingsSet({ token: 'x' }, invoke);
      // @ts-expect-error -- 올리기 선택에도 토큰 자리가 없다
      void gh.githubUpload({ planId: 'p', choices: { token: 'x' } }, invoke);
    };
    expect(typeof never).toBe('function');
    // 소스에 토큰 이름의 필드가 없다
    const src = readFileSync('src/integrations/githubIpc.ts', 'utf-8');
    expect(src).not.toMatch(/\btoken\??\s*:/i);
  });

  it('rejections become NetError, with the Rust text kept off the screen', async () => {
    const invoke = (async () => {
      throw { kind: 'offline', message: 'raw-rust-text' };
    }) as InvokeFn;
    const e = await gh.githubAccount(invoke).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(NetError);
    expect((e as NetError).kind).toBe('offline');
    expect(gh.githubErrorText(e)).not.toContain('raw-rust-text');
  });

  it('a cancelled sign-in wait sends net_cancel with its request id and rejects as cancelled', async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const invoke = ((cmd: string, args: Record<string, unknown> = {}) => {
      calls.push([cmd, args]);
      return cmd === 'github_sign_in_wait' ? new Promise(() => undefined) : Promise.resolve(true);
    }) as InvokeFn;
    const ac = new AbortController();
    const waiting = gh.githubSignInWait({ signal: ac.signal }, invoke);
    ac.abort();
    const e = (await waiting.catch((x: unknown) => x)) as NetError;
    expect(e.kind).toBe('cancelled');
    const id = calls.find(([c]) => c === 'github_sign_in_wait')?.[1].requestId;
    expect(typeof id).toBe('string');
    expect(calls).toContainEqual(['net_cancel', { requestId: id }]);
  });

  it('an upload is not cancelled when the vault changes (it cannot be stopped half way)', async () => {
    const calls: string[] = [];
    let finish!: (v: unknown) => void;
    const invoke = ((cmd: string) => {
      calls.push(cmd);
      return cmd === 'github_upload' ? new Promise<unknown>((r) => (finish = r)) : Promise.resolve(true);
    }) as InvokeFn;
    const up = gh.githubUpload({ planId: 'p', choices: {}, requestId: 'req-1' }, invoke);
    await cancelAllRequests(invoke);
    finish({ outcome: 'nothingChanged' });
    expect(await up).toEqual({ outcome: 'nothingChanged' });
    expect(calls).not.toContain('net_cancel');
  });

  it('upload and retry send the request id the caller chose (to match progress events)', async () => {
    const r = recorder();
    await gh.githubUpload({ planId: 'p', choices: { untick: ['a.md'] }, requestId: 'req-7' }, r.invoke);
    await gh.githubRetry({ folder: 'labnote/001_A', requestId: 'req-8' }, r.invoke);
    expect(r.calls).toEqual([
      ['github_upload', { requestId: 'req-7', planId: 'p', choices: { untick: ['a.md'] } }],
      ['github_retry', { requestId: 'req-8', folder: 'labnote/001_A' }],
    ]);
  });

  it('onGithubProgress listens to the pinned event and hands over its payload', async () => {
    const pinned = EVENTS.githubProgress;
    expect(pinned.name).toBe(gh.GITHUB_PROGRESS_EVENT);
    let name = '';
    let handler!: (e: { payload: unknown }) => void;
    let unlistened = 0;
    const listen = (async (n: string, h: (e: { payload: unknown }) => void) => {
      name = n;
      handler = h;
      return () => void unlistened++;
    }) as unknown as ListenFn;
    const got: gh.GithubProgress[] = [];
    const un = await gh.onGithubProgress((p) => got.push(p), listen);
    expect(name).toBe('github://progress');
    const payload: gh.GithubProgress = { requestId: 'r1', stage: 'uploading', done: 3, total: 9 };
    // 픽스처의 필드 이름이 TS 타입의 필드와 같다
    expect(Object.keys(payload).sort()).toEqual(Object.values(pinned.payload.fields).sort());
    handler({ payload });
    handler({ payload: null }); // 모양이 틀린 것은 넘기지 않는다
    expect(got).toEqual([payload]);
    un();
    expect(unlistened).toBe(1);
  });
});

describe('github error sentences', () => {
  beforeEach(() => setLang('en'));

  it('every NetError kind but cancelled has a user sentence without the Rust text', () => {
    for (const k of NET_ERROR_KINDS.filter((k) => k !== 'cancelled')) {
      const text = gh.githubErrorText(netError(k));
      expect(text.trim(), k).not.toBe('');
      expect(text, k).not.toContain('raw-rust-text');
    }
    expect(gh.githubErrorText(netError('cancelled'))).toBe('');
  });

  it('offline, timeout and TLS say that GitHub could not be reached', () => {
    for (const k of ['offline', 'timeout', 'tls'] as const) expect(gh.githubErrorText(netError(k))).toBe(t('github.err.apiLeg'));
    expect(gh.githubErrorText(netError('keyMissing'))).toBe(t('github.err.needsSignIn'));
    expect(gh.githubErrorText(new Error('boom raw-rust-text'))).not.toContain('raw-rust-text');
  });
});

/** spec §10 의 키 전부(github.import.* 는 Task 10 이 넣었다). */
const SPEC_KEYS = [
  'github.menu.upload',
  'github.menu.uploadChanges',
  'github.menu.open',
  'github.menu.unlink',
  'github.menu.finish',
  'github.menu.section',
  'github.cmd.upload',
  'github.cmd.open',
  'github.cmd.finish',
  'github.cmd.unlink',
  'github.status.synced',
  'github.status.changed',
  'github.status.unfinished',
  'github.startup.unfinished',
  'github.startup.finish',
  'github.signin.title',
  'github.signin.what',
  'github.signin.enterCode',
  'github.signin.copy',
  'github.signin.copied',
  'github.signin.reopen',
  'github.signin.waiting',
  'github.signin.noPassword',
  'github.signin.noAccount',
  'github.signin.signup',
  'github.signin.useToken',
  'github.signin.done',
  'github.signin.expired',
  'github.signin.newCode',
  'github.signin.denied',
  'github.signin.misconfigured',
  'github.signin.notConfigured',
  'github.signin.scopeMissing',
  'github.dest.title',
  'github.dest.as',
  'github.dest.switch',
  'github.dest.where',
  'github.dest.mine',
  'github.dest.typeOwner',
  'github.dest.orgMissing',
  'github.dest.name',
  'github.dest.free',
  'github.dest.taken',
  'github.dest.linkThis',
  'github.dest.rename',
  'github.dest.private',
  'github.dest.privateOrg',
  'github.dest.linkExisting',
  'github.dest.linkUrl',
  'github.dest.makePublic',
  'github.dest.next',
  'github.public.warn',
  'github.public.confirm',
  'github.public.nowPublic',
  'github.preview.title',
  'github.preview.summary',
  'github.preview.badgeNew',
  'github.preview.badgeChanged',
  'github.preview.badgeDeleted',
  'github.preview.excludedAlways',
  'github.preview.excludedByYou',
  'github.preview.mustFix',
  'github.preview.check',
  'github.preview.secret',
  'github.preview.secretSaved',
  'github.preview.kind.apiKey',
  'github.preview.kind.privateKey',
  'github.preview.kind.password',
  'github.preview.kind.token',
  'github.preview.kind.suspect',
  'github.preview.notAKey',
  'github.preview.openFile',
  'github.preview.leaveOut',
  'github.preview.tooBig',
  'github.preview.uploadTooBig',
  'github.preview.repoBig',
  'github.preview.big',
  'github.preview.author',
  'github.preview.gps',
  'github.preview.crossLinks',
  'github.preview.wikiLinks',
  'github.preview.outside',
  'github.preview.excludedLink',
  'github.preview.unused',
  'github.preview.unscanned',
  'github.preview.nfd',
  'github.preview.samples',
  'github.preview.upload',
  'github.quick.title',
  'github.quick.historyKept',
  'github.quick.details',
  'github.progress.creating',
  'github.progress.preparing',
  'github.progress.uploading',
  'github.progress.checking',
  'github.progress.noCancel',
  'github.done.title',
  'github.done.invite',
  'github.done.changes',
  'github.done.nothing',
  'github.diverged.title',
  'github.diverged.files',
  'github.diverged.mine',
  'github.diverged.mineHelp',
  'github.diverged.goneHere',
  'github.diverged.ack',
  'github.diverged.separate',
  'github.diverged.compare',
  'github.err.orgRestricted',
  'github.err.orgRequest',
  'github.err.orgAskAdmin',
  'github.err.orgMine',
  'github.err.sso',
  'github.err.ssoOpen',
  'github.err.cannotCreate',
  'github.err.notFound',
  'github.err.readOnly',
  'github.err.needsSignIn',
  'github.err.rateLimited',
  'github.err.rejected',
  'github.err.secretByGithub',
  'github.err.planStale',
  'github.err.planExpired',
  'github.err.folderHasGit',
  'github.err.vaultIsGit',
  'github.err.apiLeg',
  'github.err.gitLeg',
  'github.err.legal',
  'github.err.visibilityMismatch',
  'github.err.busy',
  'github.settings.folderMissing',
  'github.err.badPath',
  'github.unlink.title',
  'github.unlink.confirm',
  'github.signout.revoke',
  'github.signout.revokeOpen',
  'github.signout.cannotRevoke',
  'github.settings.title',
  'github.settings.account',
  'github.settings.connect',
  'github.settings.signOut',
  'github.settings.defaultOwner',
  'github.settings.readme',
  'github.settings.forgetOnExit',
  'github.settings.linked',
  'github.settings.advanced',
  'github.settings.clientId',
  'github.settings.clientIdDefault',
  'github.settings.token',
  'github.settings.tokenFineGrained',
];

describe('github.* catalog', () => {
  const { ko, en } = catalogs;

  it('has every spec §10 key in ko and en', () => {
    expect(SPEC_KEYS.length).toBeGreaterThan(140);
    const missing = SPEC_KEYS.filter((k) => !Object.hasOwn(ko, k) || !Object.hasOwn(en, k));
    expect(missing).toEqual([]);
  });

  it('Korean GitHub copy uses no Git jargon (spec §10 rule)', () => {
    // "가지"(브랜치)는 낱말 첫머리일 때만 본다: "올라가지 않습니다" 의 가지는 아니다
    const banned = /브랜치|(?<![가-힣])가지|커밋|푸시|fast-forward|소유자/i;
    expect([banned.test('가지 이름'), banned.test('커밋'), banned.test('올라가지 않습니다')]).toEqual([true, true, false]);
    const hits = Object.entries(ko)
      .filter(([k, v]) => k.startsWith('github.') && banned.test(v))
      .map(([k, v]) => `${k}: ${v}`);
    expect(hits).toEqual([]);
  });

  it('keeps the placeholders the screens fill in', () => {
    expect(ko['github.preview.secret'].match(/\{\d\}/g)?.sort()).toEqual(['{0}', '{1}', '{2}', '{3}']);
    expect(en['github.done.changes'].match(/\{\d\}/g)?.sort()).toEqual(['{0}', '{1}', '{2}', '{3}']);
    setLang('ko');
    expect(t('github.status.changed', 3)).toBe('올리지 않은 변경 3개');
    setLang('en');
  });
});
