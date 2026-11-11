import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { t } from '../i18n/t';
import { useLang } from '../i18n/useLang';
import { isComposing } from '../labnote/host/DialogFrame';
import { SignInPanel } from '../github/SignInPanel';
import { Icon } from '../ui/Icon';
import { SelectField } from '../ui/SelectField';
import { SettingRow, Toggle } from '../ui/settings/SettingRow';
import { KeyField } from './KeyField';
import {
  githubErrorText,
  type Account,
  type FolderStatus,
  type GithubAppSettings,
  type GithubAppSettingsPatch,
  type Owner,
  type OwnersOutcome,
  type SignInOutcome,
  type SignInStart,
  type TokenOutcome,
} from './githubIpc';
import type { SecretStatus } from './netIpc';

/**
 * 설정의 GitHub 묶음이 쓰는 바깥 함수(spec §9). 토큰은 `setToken` 으로 Rust 에 들어가기만 하고 돌아오지 않는다.
 * 기다리기의 취소는 `signInWait` 의 `signal` 이 한다(끊으면 `net_cancel`).
 */
export interface GithubDeps {
  account(): Promise<Account | null>;
  /** 자격 증명 관리자의 '설정됨' 여부(`secret_status`). 토큰 칸의 상태 꼬리표에 쓴다. */
  secretStatus(): Promise<SecretStatus>;
  signInStart(): Promise<SignInStart>;
  signInWait(signal: AbortSignal): Promise<SignInOutcome>;
  signOut(): Promise<void>;
  setToken(value: string): Promise<TokenOutcome>;
  statuses(): Promise<Record<string, FolderStatus>>;
  unlink(folder: string): Promise<void>;
  openExternal(url: string): Promise<unknown>;
  copy(text: string): Promise<void>;
  appSettings(): Promise<GithubAppSettings>;
  setAppSettings(patch: GithubAppSettingsPatch): Promise<GithubAppSettings>;
  /** 보관함 설정 `githubReadmeOverlay`(기본 켬). */
  readmeOverlay(): boolean;
  commitReadmeOverlay(value: boolean): Promise<void>;
  owners(signal?: AbortSignal): Promise<OwnersOutcome>;
  defaultOwner(): Promise<string | undefined>;
  setDefaultOwner(owner: string): Promise<void>;
}

/** 설정 창을 열 때 초점을 줄 곳(로그인 대화상자의 "토큰으로 연결"). */
export type GithubFocus = 'githubToken';

const CLIENT_ID = /^[A-Za-z0-9.]{1,64}$/;

/**
 * "GitHub 쪽 연결까지 끊기" 주소. client ID 를 알면 그 앱의 쪽, 모르면(빌드 기본값만 쓰는 중) GitHub 의 승인한 앱 목록.
 * 기본값은 Rust 에만 있어서 웹뷰가 모른다.
 */
export function revokeUrl(clientId: string | undefined): string {
  return clientId && CLIENT_ID.test(clientId)
    ? `https://github.com/settings/connections/applications/${clientId}`
    : 'https://github.com/settings/applications';
}

/** 연결된 실험 한 줄의 상태 글. */
function statusText(s: FolderStatus): string {
  if (s.folderMissing) return t('github.settings.folderMissing');
  if (s.state !== 'pushed') return t('github.status.unfinished');
  if (s.changedCount > 0) return t('github.status.changed', s.changedCount);
  return t('github.status.synced');
}

/** 폴더 경로의 마지막 이름(실험 이름). */
function titleOf(folder: string): string {
  const parts = folder.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? folder;
}

const EMPTY: SecretStatus['set'] = {
  partbankDesktop: false,
  partbankWeb: false,
  llmOpenai: false,
  bfwServer: false,
  bfwDesktop: false,
  slackBot: false,
  ncbiEutils: false,
  github: false,
  githubRefresh: false,
  webSearch: false,
};

/**
 * 설정 창 → 연동 쪽의 GitHub 묶음(spec §9). MCP·스킬 묶음 뒤에 온다.
 * - 설정 창은 줄 선 대화상자라 이 묶음은 대화상자를 열지 않는다: 로그인 판, 연결 끊기 확인, 로그아웃 뒤 안내가 모두 이 자리에 그려진다.
 * - 계정, 기본 올릴 곳, README·로그아웃 스위치, 연결된 실험, 고급(Client ID, 토큰).
 * - 공개 여부 기본값 설정은 없다(늘 비공개로 시작한다).
 */
export function GithubSection(props: { deps: GithubDeps; onLeave(): Promise<void>; focus?: GithubFocus }) {
  useLang();
  const { deps } = props;
  const id = useId();
  const alive = useRef(true);
  const [account, setAccount] = useState<Account | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [keySet, setKeySet] = useState<SecretStatus['set']>(EMPTY);
  const [app, setApp] = useState<GithubAppSettings>({ clientIdDefault: true, forgetOnExit: false });
  const [statuses, setStatuses] = useState<Record<string, FolderStatus>>({});
  const [owners, setOwners] = useState<Owner[]>([]);
  const [orgsHidden, setOrgsHidden] = useState(false);
  const [defaultOwner, setDefaultOwner] = useState<string | undefined>(undefined);
  const [readme, setReadme] = useState(() => deps.readmeOverlay());
  const [signing, setSigning] = useState(false);
  const [signedOutNote, setSignedOutNote] = useState(false);
  const [unlinkAsk, setUnlinkAsk] = useState<string | undefined>(undefined);
  const [advanced, setAdvanced] = useState(props.focus === 'githubToken');
  const [focusToken, setFocusToken] = useState(0);
  const [clientDraft, setClientDraft] = useState('');
  const [tokenNote, setTokenNote] = useState<string | undefined>(undefined);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const tokenRef = useRef<HTMLInputElement>(null);
  const ownersAbort = useRef<AbortController | null>(null);

  const safe = <T,>(p: Promise<T>): Promise<T | undefined> => p.then((v) => v, () => undefined);

  /** 올릴 곳 목록(네트워크). 가져온 토큰만 있고 계정 기록이 없으면, 이 부름이 계정을 적으므로 다시 읽는다. */
  const loadOwners = async (known: Account | null) => {
    ownersAbort.current?.abort();
    const ctl = new AbortController();
    ownersAbort.current = ctl;
    const r = await safe(deps.owners(ctl.signal));
    if (!alive.current || ctl.signal.aborted || !r) return;
    if (r.outcome !== 'ok') return;
    setOwners(r.owners);
    setOrgsHidden(!r.orgsListed);
    if (!known) {
      const a = await safe(deps.account());
      if (alive.current && a) setAccount(a);
    }
  };

  const refreshKeys = async () => {
    const s = await safe(deps.secretStatus());
    if (alive.current && s) setKeySet(s.set);
  };

  const load = async () => {
    const [a, s, cfg, st, owner] = await Promise.all([
      safe(deps.account()),
      safe(deps.secretStatus()),
      safe(deps.appSettings()),
      safe(deps.statuses()),
      safe(deps.defaultOwner()),
    ]);
    if (!alive.current) return;
    setAccount(a ?? null);
    if (s) setKeySet(s.set);
    if (cfg) {
      setApp(cfg);
      setClientDraft(cfg.clientId ?? '');
    }
    if (st) setStatuses(st);
    setDefaultOwner(owner ?? undefined);
    setLoaded(true);
    if (props.focus === 'githubToken') setFocusToken((n) => n + 1);
    if (a || s?.set.github) await loadOwners(a ?? null);
  };

  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
      ownersAbort.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (focusToken > 0 && advanced) tokenRef.current?.focus();
  }, [focusToken, advanced]);

  const afterSignIn = async (a: Account | null) => {
    setSigning(false);
    setSignedOutNote(false);
    if (a) setAccount(a);
    await refreshKeys();
    await loadOwners(a);
  };

  const signOut = async () => {
    setProblem(undefined);
    try {
      await deps.signOut();
    } catch (e) {
      setProblem(githubErrorText(e) || t('github.err.local'));
      return;
    }
    if (!alive.current) return;
    ownersAbort.current?.abort();
    setAccount(null);
    setOwners([]);
    setOrgsHidden(false);
    setTokenNote(undefined);
    setSignedOutNote(true);
    await refreshKeys();
  };

  const onToken = async (r: TokenOutcome) => {
    setProblem(undefined);
    switch (r.outcome) {
      case 'saved': {
        setTokenNote(r.fineGrained ? t('github.settings.tokenFineGrained') : undefined);
        const a = await safe(deps.account());
        await afterSignIn(a ?? { login: r.login, id: 0, avatarUrl: '' });
        return;
      }
      case 'badToken':
        setProblem(t('github.import.badToken'));
        return;
      case 'scopeMissing':
        setProblem(t('github.signin.scopeMissing'));
        return;
      case 'needsSignIn':
        setProblem(t('github.err.needsSignIn'));
        return;
    }
  };

  const tokenDeps = {
    setSecret: async (_slot: unknown, value: string) => {
      await onToken(await deps.setToken(value));
    },
    clearSecret: () => signOut(),
    status: () => deps.secretStatus(),
  };

  const saveApp = async (patch: GithubAppSettingsPatch) => {
    setProblem(undefined);
    try {
      const next = await deps.setAppSettings(patch);
      if (!alive.current) return;
      setApp(next);
      setClientDraft(next.clientId ?? '');
    } catch (e) {
      setProblem(githubErrorText(e) || t('github.err.local'));
      return;
    }
    if ('clientId' in patch) {
      // client ID 가 바뀌면 Rust 가 로그아웃한다(토큰은 그 앱의 것이다).
      const a = await safe(deps.account());
      if (!alive.current) return;
      setAccount(a ?? null);
      if (!a) setOwners([]);
      await refreshKeys();
    }
  };

  const commitClientId = () => {
    const v = clientDraft.trim();
    if (v === (app.clientId ?? '')) return;
    void saveApp({ clientId: v ? v : null });
  };

  const onClientKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter' || isComposing(e)) return;
    e.preventDefault();
    commitClientId();
  };

  const toggleReadme = async (v: boolean) => {
    setReadme(v);
    try {
      await deps.commitReadmeOverlay(v);
    } catch {
      if (alive.current) setReadme(!v);
    }
  };

  const unlink = async (folder: string) => {
    setProblem(undefined);
    try {
      await deps.unlink(folder);
    } catch (e) {
      setProblem(githubErrorText(e) || t('github.err.local'));
      return;
    }
    if (!alive.current) return;
    setUnlinkAsk(undefined);
    const st = await safe(deps.statuses());
    if (!alive.current) return;
    if (st) setStatuses(st);
    else
      setStatuses((s) => {
        const next = { ...s };
        delete next[folder];
        return next;
      });
  };

  const open = (url: string) => void deps.openExternal(url).catch(() => undefined);

  const useToken = () => {
    setSigning(false);
    setAdvanced(true);
    setFocusToken((n) => n + 1);
  };

  const me = owners.find((o) => o.kind === 'user')?.login ?? account?.login;
  const ownerOptions: Array<{ value: string; label: string }> = [];
  for (const o of owners) ownerOptions.push({ value: o.login, label: o.kind === 'user' ? t('github.dest.mine', o.login) : o.login });
  if (ownerOptions.length === 0 && me) ownerOptions.push({ value: me, label: t('github.dest.mine', me) });
  if (defaultOwner && !ownerOptions.some((o) => o.value === defaultOwner)) ownerOptions.push({ value: defaultOwner, label: defaultOwner });
  const ownerValue = defaultOwner ?? me ?? '';

  const linked = Object.entries(statuses)
    .filter(([, s]) => s.linked)
    .sort(([a], [b]) => a.localeCompare(b));

  const fineGrained = tokenNote ?? (orgsHidden ? t('github.settings.tokenFineGrained') : undefined);

  const accountControl = account ? (
    <>
      <button type="button" onClick={() => void signOut()}>
        <Icon name="log-out" size={14} />
        <span>{t('github.settings.signOut')}</span>
      </button>
      <button type="button" onClick={() => setSigning(true)}>
        {t('github.dest.switch')}
      </button>
    </>
  ) : (
    <button type="button" onClick={() => setSigning(true)} disabled={!loaded}>
      <Icon name="log-in" size={14} />
      <span>{t('github.settings.connect')}</span>
    </button>
  );

  return (
    <section className="integration-section github-section" aria-labelledby={`${id}-head`}>
      <h5 id={`${id}-head`}>{t('github.settings.title')}</h5>

      {signing ? (
        <SignInPanel
          deps={{ signInStart: deps.signInStart, signInWait: deps.signInWait, openExternal: deps.openExternal, copy: deps.copy }}
          onSignedIn={(a) => void afterSignIn(a)}
          onCancel={() => setSigning(false)}
          onUseToken={useToken}
        />
      ) : (
        <SettingRow label={t('github.settings.account')} description={account ? `@${account.login}` : undefined} control={accountControl} />
      )}

      {fineGrained && account ? <p className="prompt-hint github-note">{fineGrained}</p> : null}

      {account || signedOutNote ? (
        <div className="github-revoke">
          {signedOutNote ? <p className="prompt-hint">{t('github.signout.cannotRevoke')}</p> : null}
          <div className="github-actions">
            <span className="prompt-hint">{t('github.signout.revoke')}</span>
            <button type="button" className="github-link" onClick={() => open(revokeUrl(app.clientId))}>
              <span>{t('github.signout.revokeOpen')}</span>
              <Icon name="external-link" size={14} />
            </button>
          </div>
        </div>
      ) : null}

      {account ? (
        <SettingRow
          label={t('github.settings.defaultOwner')}
          control={
            <SelectField
              id={`${id}-owner`}
              aria-label={t('github.settings.defaultOwner')}
              value={ownerValue}
              onChange={(e) => {
                const v = e.target.value;
                setDefaultOwner(v);
                void deps.setDefaultOwner(v).catch((err) => setProblem(githubErrorText(err) || t('github.err.local')));
              }}
            >
              {ownerOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </SelectField>
          }
        />
      ) : null}

      <SettingRow
        label={t('github.settings.readme')}
        control={<Toggle checked={readme} label={t('github.settings.readme')} onChange={(v) => void toggleReadme(v)} />}
      />
      <SettingRow
        label={t('github.settings.forgetOnExit')}
        control={
          <Toggle checked={app.forgetOnExit} label={t('github.settings.forgetOnExit')} onChange={(v) => void saveApp({ forgetOnExit: v })} />
        }
      />

      {linked.length > 0 ? (
        <div className="github-linked">
          <div className="setting-name" id={`${id}-linked`}>
            {t('github.settings.linked')}
          </div>
          <ul aria-labelledby={`${id}-linked`}>
            {linked.map(([folder, s]) => (
              <li key={folder} className="github-linked-item">
                <div className="github-linked-row">
                  <div className="github-linked-info">
                    <span className="github-linked-title">{titleOf(folder)}</span>
                    {s.fullName ? <span className="github-linked-repo">{s.fullName}</span> : null}
                    <span className={s.folderMissing || s.state !== 'pushed' ? 'github-linked-status warn' : 'github-linked-status'}>
                      {statusText(s)}
                    </span>
                  </div>
                  <div className="github-actions">
                    {s.htmlUrl ? (
                      <button type="button" onClick={() => open(s.htmlUrl!)}>
                        {t('github.menu.open')}
                      </button>
                    ) : null}
                    {unlinkAsk !== folder ? (
                      <button type="button" onClick={() => setUnlinkAsk(folder)}>
                        {t('github.unlink.title')}
                      </button>
                    ) : null}
                  </div>
                </div>
                {unlinkAsk === folder ? (
                  <div className="github-confirm" role="group" aria-label={t('github.unlink.title')}>
                    <p className="prompt-hint">{t('github.unlink.confirm')}</p>
                    <div className="github-actions">
                      <button type="button" onClick={() => void unlink(folder)}>
                        {t('github.unlink.title')}
                      </button>
                      <button type="button" onClick={() => setUnlinkAsk(undefined)}>
                        {t('dialog.cancel')}
                      </button>
                    </div>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="github-advanced">
        <button type="button" className="github-disclosure" aria-expanded={advanced} onClick={() => setAdvanced((v) => !v)}>
          <Icon name={advanced ? 'chevron-down' : 'chevron-right'} size={14} />
          <span>{t('github.settings.advanced')}</span>
        </button>
        {advanced ? (
          <div className="integration-group">
            <div className="integration-field">
              <label className="prompt-question" htmlFor={`${id}-client`}>
                {t('github.settings.clientId')}
              </label>
              <input
                id={`${id}-client`}
                type="text"
                autoComplete="off"
                spellCheck={false}
                placeholder={
                  !app.clientIdDefault ? '' : app.builtinAvailable ? t('github.settings.clientIdDefault') : t('github.settings.clientIdNeeded')
                }
                value={clientDraft}
                onChange={(e) => setClientDraft(e.target.value)}
                onBlur={commitClientId}
                onKeyDown={onClientKey}
              />
            </div>
            <KeyField
              deps={tokenDeps}
              slot="github"
              label={t('github.settings.token')}
              hints={[t('github.signin.noPassword')]}
              isSet={keySet.github}
              inputRef={tokenRef}
              onSaved={(s) => {
                if (s && alive.current) setKeySet(s.set);
              }}
            />
          </div>
        ) : null}
      </div>

      {problem ? (
        <p role="alert" className="prompt-hint warn">
          {problem}
        </p>
      ) : null}
    </section>
  );
}
