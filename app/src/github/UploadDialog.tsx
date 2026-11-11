import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { t } from '../i18n/t';
import { useLang } from '../i18n/useLang';
import { DialogFrame, isComposing } from '../labnote/host/DialogFrame';
import type { DialogSpec } from '../labnote/host/dialogStore';
import { Icon } from '../ui/Icon';
import { SelectField } from '../ui/SelectField';
import type { Account, NameCheck, Owner, OwnersOutcome, ResolveOutcome } from '../integrations/githubIpc';
import { githubErrorText } from '../integrations/githubIpc';
import { apiFailureText } from './outcomeText';
import { nextFreeName, repoNameFor } from './slug';

/** 화면 B 를 여는 값(spec §5.3). */
export interface DestinationInit {
  /** 실험 제목(한글 그대로). */
  title: string;
  /** 실험 폴더 이름(`001_단백질_발현`). */
  folderName: string;
  account: Account;
  /** 폴더 이름의 저장소 이름 꼴(`slugify`). */
  slug: string;
  /** 지난번에 올린 곳(Rust 의 `defaultOwner`). */
  defaultOwner?: string;
  /** 이 곳으로 미리 고른다(조직이 막았을 때의 "내 계정에 올리기"). `defaultOwner` 보다 앞선다. */
  owner?: string;
  /** 처음 보일 쪽: 새 저장소(기본) 또는 이미 있는 저장소에 연결. */
  mode?: 'new' | 'link';
}

/** 화면 B 가 쓰는 바깥 함수. 모두 Rust 를 거친다(토큰은 지나가지 않는다). */
export interface DestinationDeps {
  owners(signal?: AbortSignal): Promise<OwnersOutcome>;
  nameCheck(owner: string, name: string): Promise<NameCheck>;
  resolveRepo(url: string): Promise<ResolveOutcome>;
  /** 이름 확인을 미루는 시간(기본 400ms). */
  nameCheckDelayMs?: number;
}

/** 화면 B 의 답. 공개는 저장소 이름을 그대로 쳐 넣었을 때만(`publicConfirm`, Rust 가 다시 확인한다). */
export type Destination =
  | { kind: 'create'; owner: string; name: string; private: boolean; publicConfirm?: string }
  | { kind: 'link'; owner: string; name: string; publicConfirm?: string }
  | { kind: 'switchAccount' };

export type DestinationSpec = { kind: 'githubDestination'; init: DestinationInit; deps: DestinationDeps };

/** 고르기의 "직접 입력…" 값(GitHub 이름에는 쓸 수 없는 글자로 시작한다). */
const TYPE_OWNER = '\u0000type';

type Check =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'free' }
  | { state: 'taken'; canPush: boolean; private: boolean }
  | { state: 'invalid' }
  | { state: 'error'; text: string };

type Linked =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'ok'; url: string; owner: string; name: string; private: boolean; canPush: boolean }
  | { state: 'error'; text: string };

function checkOf(c: NameCheck): Check {
  switch (c.outcome) {
    case 'free':
      return { state: 'free' };
    case 'taken':
      return { state: 'taken', canPush: c.canPush, private: c.private };
    case 'invalidName':
      return { state: 'invalid' };
    default:
      return { state: 'error', text: apiFailureText(c) };
  }
}

// 한글 조합을 끝내는 Enter 는 폼을 내지 않는다
const holdComposingEnter = (e: KeyboardEvent<HTMLInputElement>) => {
  if (e.key === 'Enter' && isComposing(e)) e.preventDefault();
};

/**
 * spec §5.3 화면 B: 처음 올리는 폴더의 한 장짜리 양식.
 * - 올릴 곳은 지난번 곳(없으면 내 계정)으로 미리 고른다. 조직을 고르면 이름이 `{login}-{slug}` 로 바뀐다(손대지 않았을 때만).
 * - 이름은 400ms 뒤에 확인한다. 이미 있으면 [이 저장소에 연결] [이름 바꾸기].
 * - 언제나 비공개다. 공개는 "공개 저장소로 만들기…" 에서 저장소 이름을 그대로 쳐 넣어야만 된다.
 * - "이미 있는 저장소에 연결" 은 주소를 받아 Rust 가 확인한다. 공개 저장소면 같은 확인을 거친다.
 */
export function UploadDialog(props: {
  spec: Extract<DialogSpec, { kind: 'githubDestination' }>;
  onDone: (value: Destination) => void;
  onCancel: () => void;
}) {
  useLang();
  const { init, deps } = props.spec;
  const me = init.account.login;
  const id = useId();
  const start = init.owner ?? init.defaultOwner ?? me;

  const [owners, setOwners] = useState<Owner[]>(() =>
    start === me ? [{ login: me, kind: 'user' }] : [{ login: me, kind: 'user' }, { login: start, kind: 'org' }],
  );
  const [orgsListed, setOrgsListed] = useState(true);
  const [choice, setChoice] = useState(start);
  const [typed, setTyped] = useState('');
  const owner = choice === TYPE_OWNER ? typed.trim() : choice;
  const ownerKind: Owner['kind'] =
    choice === TYPE_OWNER ? (owner.toLowerCase() === me.toLowerCase() ? 'user' : 'org') : (owners.find((o) => o.login === choice)?.kind ?? 'org');

  const [name, setName] = useState(() => repoNameFor({ login: start, kind: start === me ? 'user' : 'org' }, me, init.slug));
  const edited = useRef(false);
  const renames = useRef(1);
  const [check, setCheck] = useState<Check>({ state: 'idle' });
  const [mode, setMode] = useState<'new' | 'link'>(init.mode ?? 'new');
  const [publicOpen, setPublicOpen] = useState(false);
  const [publicTyped, setPublicTyped] = useState('');
  const [url, setUrl] = useState('');
  const [linked, setLinked] = useState<Linked>({ state: 'idle' });
  const [linkTyped, setLinkTyped] = useState('');

  // 올릴 곳 목록(내 계정이 먼저). 못 읽으면 내 계정과 "직접 입력…" 만 남는다.
  useEffect(() => {
    const ctl = new AbortController();
    deps.owners(ctl.signal).then(
      (o) => {
        if (ctl.signal.aborted || o.outcome !== 'ok') return;
        setOrgsListed(o.orgsListed);
        setOwners((before) => {
          const list = o.owners.length > 0 ? [...o.owners] : [{ login: me, kind: 'user' as const }];
          // 미리 고른 곳이 목록에 없으면(숨은 조직) 그대로 둔다.
          for (const b of before) if (!list.some((x) => x.login.toLowerCase() === b.login.toLowerCase())) list.push(b);
          return list;
        });
      },
      () => undefined,
    );
    return () => ctl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 이름 확인(미뤄서). 늦게 온 답은 버린다.
  useEffect(() => {
    if (mode !== 'new') return;
    if (!owner || !name) {
      setCheck({ state: 'idle' });
      return;
    }
    let live = true;
    setCheck({ state: 'checking' });
    const timer = setTimeout(() => {
      deps.nameCheck(owner, name).then(
        (c) => {
          if (live) setCheck(checkOf(c));
        },
        (e) => {
          if (live) setCheck({ state: 'error', text: githubErrorText(e) || t('github.err.apiLeg') });
        },
      );
    }, deps.nameCheckDelayMs ?? 400);
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner, name, mode]);

  const chooseOwner = (value: string) => {
    setChoice(value);
    if (edited.current) return;
    const login = value === TYPE_OWNER ? typed.trim() || me : value;
    const kind = value === TYPE_OWNER ? (login.toLowerCase() === me.toLowerCase() ? 'user' : 'org') : (owners.find((o) => o.login === value)?.kind ?? 'org');
    setName(repoNameFor({ login, kind }, me, init.slug));
  };

  const typeOwner = (value: string) => {
    setTyped(value);
    if (edited.current) return;
    const login = value.trim();
    setName(repoNameFor({ login, kind: login.toLowerCase() === me.toLowerCase() || login === '' ? 'user' : 'org' }, me, init.slug));
  };

  const rename = () => {
    renames.current += 1;
    edited.current = true;
    const base = repoNameFor({ login: owner, kind: ownerKind }, me, init.slug);
    setName(nextFreeName(base, renames.current));
  };

  const next = () => {
    if (check.state !== 'free' || !owner) return;
    props.onDone({ kind: 'create', owner, name, private: true });
  };

  const makePublic = () => {
    if (check.state !== 'free' || publicTyped !== name) return;
    props.onDone({ kind: 'create', owner, name, private: false, publicConfirm: publicTyped });
  };

  const linkThis = () => {
    if (check.state !== 'taken' || !check.canPush) return;
    if (!check.private) {
      // 공개 저장소에 연결: 주소 쪽의 같은 확인을 거친다.
      setMode('link');
      setUrl(`${owner}/${name}`);
      setLinked({ state: 'ok', url: `${owner}/${name}`, owner, name, private: false, canPush: true });
      return;
    }
    props.onDone({ kind: 'link', owner, name });
  };

  const linkNext = async () => {
    const wanted = url.trim();
    if (!wanted) return;
    let current = linked;
    if (current.state !== 'ok' || current.url !== wanted) {
      setLinked({ state: 'checking' });
      let r: ResolveOutcome;
      try {
        r = await deps.resolveRepo(wanted);
      } catch (e) {
        setLinked({ state: 'error', text: githubErrorText(e) || t('github.err.apiLeg') });
        return;
      }
      if (r.outcome === 'invalidUrl') {
        setLinked({ state: 'error', text: t('github.err.notFound') });
        return;
      }
      if (r.outcome !== 'ok') {
        setLinked({ state: 'error', text: apiFailureText(r) });
        return;
      }
      current = { state: 'ok', url: wanted, owner: r.owner, name: r.name, private: r.private, canPush: r.canPush };
      setLinked(current);
      setLinkTyped('');
      // 공개 저장소면 이름을 쳐 넣을 때까지 기다린다.
      if (!r.canPush || !r.private) return;
    }
    if (current.state !== 'ok' || !current.canPush) return;
    if (current.private) props.onDone({ kind: 'link', owner: current.owner, name: current.name });
    else if (linkTyped === current.name) props.onDone({ kind: 'link', owner: current.owner, name: current.name, publicConfirm: linkTyped });
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (mode === 'new') next();
    else void linkNext();
  };

  const checkText = (() => {
    switch (check.state) {
      case 'checking':
        return t('github.progress.checking');
      case 'free':
        return t('github.dest.free');
      case 'taken':
        return check.canPush ? t('github.dest.taken') : `${t('github.dest.taken')} — ${t('github.err.readOnly')}`;
      case 'invalid':
        return t('github.dest.invalid');
      case 'error':
        return check.text;
      case 'idle':
        return '';
    }
  })();

  const linkNeedsPublic = linked.state === 'ok' && linked.canPush && !linked.private;
  const linkNextDisabled = !url.trim() || linked.state === 'checking' || (linkNeedsPublic && linked.state === 'ok' && linkTyped !== linked.name && url.trim() === linked.url);

  return (
    <DialogFrame title={t('github.dest.title', init.title)} className="github-dialog github-dest" onCancel={props.onCancel}>
      <form className="github-form" onSubmit={onSubmit}>
        <p className="prompt-hint">{init.folderName}</p>
        <div className="github-actions">
          <span>{t('github.dest.as', me)}</span>
          <button type="button" className="github-link" onClick={() => props.onDone({ kind: 'switchAccount' })}>
            {t('github.dest.switch')}
          </button>
        </div>
        {mode === 'new' ? (
          <>
            <label className="prompt-question" htmlFor={`${id}-owner`}>
              {t('github.dest.where')}
            </label>
            <SelectField id={`${id}-owner`} value={choice} onChange={(e) => chooseOwner(e.target.value)}>
              {owners.map((o) => (
                <option key={o.login} value={o.login}>
                  {o.kind === 'user' ? t('github.dest.mine', o.login) : o.login}
                </option>
              ))}
              <option value={TYPE_OWNER}>{t('github.dest.typeOwner')}</option>
            </SelectField>
            {choice === TYPE_OWNER ? (
              <input
                type="text"
                autoComplete="off"
                spellCheck={false}
                aria-label={t('github.dest.typedOwner')}
                value={typed}
                onChange={(e) => typeOwner(e.target.value)}
                onKeyDown={holdComposingEnter}
              />
            ) : null}
            <p className="prompt-hint">{orgsListed ? t('github.dest.orgMissing') : t('github.settings.tokenFineGrained')}</p>
            <label className="prompt-question" htmlFor={`${id}-name`}>
              {t('github.dest.name')}
            </label>
            <input
              id={`${id}-name`}
              type="text"
              autoComplete="off"
              spellCheck={false}
              aria-describedby={`${id}-check`}
              value={name}
              onChange={(e) => {
                edited.current = true;
                setName(e.target.value);
              }}
              onKeyDown={holdComposingEnter}
            />
            <p id={`${id}-check`} className={`github-check ${check.state}`} aria-live="polite">
              {check.state === 'free' ? <Icon name="check" size={14} /> : null}
              <span>{checkText}</span>
            </p>
            {check.state === 'taken' ? (
              <div className="github-actions">
                <button type="button" disabled={!check.canPush} onClick={linkThis}>
                  {t('github.dest.linkThis')}
                </button>
                <button type="button" onClick={rename}>
                  {t('github.dest.rename')}
                </button>
              </div>
            ) : null}
            <p className="github-private">
              <Icon name="lock" size={14} />
              <span>{ownerKind === 'org' ? t('github.dest.privateOrg') : t('github.dest.private')}</span>
            </p>
            <div className="github-actions">
              <span className="prompt-hint">{t('github.dest.otherWays')}</span>
              <button type="button" className="github-link" onClick={() => setMode('link')}>
                {t('github.dest.linkExisting')}
              </button>
              <button type="button" className="github-link" aria-expanded={publicOpen} onClick={() => setPublicOpen((v) => !v)}>
                {t('github.dest.makePublic')}
              </button>
            </div>
            {publicOpen ? (
              <div className="github-confirm github-public">
                <p id={`${id}-public`}>
                  <Icon name="globe" size={14} /> <span>{t('github.public.warn', name)}</span>
                </p>
                <input
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  aria-label={t('github.public.confirm')}
                  aria-describedby={`${id}-public`}
                  value={publicTyped}
                  onChange={(e) => setPublicTyped(e.target.value)}
                  onKeyDown={holdComposingEnter}
                />
                <div className="github-actions">
                  <button type="button" className="danger" disabled={check.state !== 'free' || publicTyped !== name} onClick={makePublic}>
                    {t('github.public.confirm')}
                  </button>
                </div>
              </div>
            ) : null}
            <div className="dialog-actions">
              <button type="button" onClick={props.onCancel}>
                {t('dialog.cancel')}
              </button>
              <button type="submit" className="primary" disabled={check.state !== 'free' || !owner}>
                {t('github.dest.next')}
              </button>
            </div>
          </>
        ) : (
          <>
            <label className="prompt-question" htmlFor={`${id}-url`}>
              {t('github.dest.linkUrl')}
            </label>
            <input
              id={`${id}-url`}
              type="text"
              autoComplete="off"
              spellCheck={false}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={holdComposingEnter}
            />
            {linked.state === 'checking' ? <p className="prompt-hint">{t('github.progress.checking')}</p> : null}
            {linked.state === 'error' ? (
              <p role="alert" className="prompt-hint warn">
                {linked.text}
              </p>
            ) : null}
            {linked.state === 'ok' && !linked.canPush ? (
              <p role="alert" className="prompt-hint warn">
                {t('github.err.readOnly')}
              </p>
            ) : null}
            {linked.state === 'ok' && linked.canPush ? (
              <p className="github-private">
                <Icon name={linked.private ? 'lock' : 'globe'} size={14} />
                <span>
                  {linked.owner}/{linked.name}
                </span>
              </p>
            ) : null}
            {linkNeedsPublic && linked.state === 'ok' ? (
              <div className="github-confirm github-public">
                <p id={`${id}-link-public`}>{t('github.public.warn', linked.name)}</p>
                <input
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  aria-label={t('github.public.confirm')}
                  aria-describedby={`${id}-link-public`}
                  value={linkTyped}
                  onChange={(e) => setLinkTyped(e.target.value)}
                  onKeyDown={holdComposingEnter}
                />
              </div>
            ) : null}
            <div className="github-actions">
              <button type="button" className="github-link" onClick={() => setMode('new')}>
                {t('github.dest.newRepo')}
              </button>
            </div>
            <div className="dialog-actions">
              <button type="button" onClick={props.onCancel}>
                {t('dialog.cancel')}
              </button>
              <button type="submit" className="primary" disabled={linkNextDisabled}>
                {t('github.dest.next')}
              </button>
            </div>
          </>
        )}
      </form>
    </DialogFrame>
  );
}
