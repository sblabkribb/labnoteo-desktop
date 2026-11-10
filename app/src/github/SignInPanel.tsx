import { useEffect, useRef, useState } from 'react';
import { t } from '../i18n/t';
import { useLang } from '../i18n/useLang';
import { Icon } from '../ui/Icon';
import type { Account, SignInOutcome, SignInStart } from '../integrations/githubIpc';

/** 가입 쪽. 기기 코드를 넣는 쪽은 Rust 가 고른 `verificationUri` 다(GitHub 의 것이거나 시험용 가짜 서버). */
export const GITHUB_SIGNUP_URL = 'https://github.com/signup';

/** 이 판이 쓰는 바깥 함수. 토큰은 지나가지 않는다: 코드와 끝난 뒤의 계정만 온다. */
export interface SignInPanelDeps {
  signInStart(): Promise<SignInStart>;
  /** 끊으면(`signal`) `net_cancel` 이 Rust 의 기다림을 멈춘다(`githubSignInWait` 의 trackRequest). */
  signInWait(signal: AbortSignal): Promise<SignInOutcome>;
  openExternal(url: string): Promise<unknown> | void;
  copy(text: string): Promise<void>;
}

type Phase =
  | { kind: 'starting' }
  | { kind: 'code'; userCode: string; verificationUri: string; deadline: number; copied: boolean }
  | { kind: 'done'; login: string }
  | { kind: 'problem'; text: string; again: boolean; useToken: boolean };

/** 남은 시간 `m:ss`(1시간을 넘으면 분이 그대로 커진다). */
export function remaining(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function problemOf(o: Exclude<SignInOutcome, { outcome: 'signedIn' }> | Exclude<SignInStart, { outcome: 'started' }>): Phase {
  switch (o.outcome) {
    case 'expired':
      return { kind: 'problem', text: t('github.signin.expired'), again: true, useToken: false };
    case 'denied':
      return { kind: 'problem', text: t('github.signin.denied'), again: true, useToken: false };
    case 'scopeMissing':
      return { kind: 'problem', text: t('github.signin.scopeMissing'), again: true, useToken: false };
    case 'appMisconfigured':
      return { kind: 'problem', text: t('github.signin.misconfigured'), again: false, useToken: true };
    case 'notConfigured':
      return { kind: 'problem', text: t('github.signin.notConfigured'), again: false, useToken: true };
    case 'cancelled':
      return { kind: 'problem', text: '', again: true, useToken: false };
  }
}

/**
 * spec §5.2 화면 A 의 몸통: GitHub 기기 코드 로그인. 설정의 GitHub 묶음은 이것을 그 자리에 그리고(설정 창은 줄 선
 * 대화상자라 그 위에 다른 대화상자를 열 수 없다), 올리기 흐름은 대화상자 안에 그린다(Task 13).
 * - 열리면 코드를 받고, 클립보드에 복사하고, 브라우저를 연 뒤 기다린다.
 * - 취소는 기다림을 끊는다(`net_cancel`). 사라질 때도 끊는다.
 * - 연결되면 "@login 계정으로 연결되었습니다" 를 보이고 `doneDelayMs` 뒤에 `onSignedIn` 을 부른다.
 */
export function SignInPanel(props: {
  deps: SignInPanelDeps;
  onSignedIn(account: Account): void;
  onCancel(): void;
  /** "토큰으로 연결 (고급)". 없으면 단추를 그리지 않는다. */
  onUseToken?: () => void;
  doneDelayMs?: number;
  now?: () => number;
}) {
  useLang();
  const now = props.now ?? Date.now;
  const [phase, setPhase] = useState<Phase>({ kind: 'starting' });
  const [round, setRound] = useState(0);
  const [, setTick] = useState(0);
  const latest = useRef(props);
  latest.current = props;
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    const ctl = new AbortController();
    abort.current = ctl;
    let doneTimer: ReturnType<typeof setTimeout> | undefined;
    const run = async () => {
      const { deps } = latest.current;
      let start: SignInStart;
      try {
        start = await deps.signInStart();
      } catch {
        if (!ctl.signal.aborted) setPhase({ kind: 'problem', text: t('github.err.apiLeg'), again: true, useToken: true });
        return;
      }
      if (ctl.signal.aborted) return;
      if (start.outcome !== 'started') {
        setPhase(problemOf(start));
        return;
      }
      const deadline = now() + start.expiresIn * 1000;
      setPhase({ kind: 'code', userCode: start.userCode, verificationUri: start.verificationUri, deadline, copied: false });
      deps.copy(start.userCode).then(
        () => {
          if (!ctl.signal.aborted) setPhase((p) => (p.kind === 'code' ? { ...p, copied: true } : p));
        },
        () => undefined,
      );
      void Promise.resolve(deps.openExternal(start.verificationUri)).catch(() => undefined);
      let outcome: SignInOutcome;
      try {
        outcome = await deps.signInWait(ctl.signal);
      } catch {
        if (!ctl.signal.aborted) setPhase({ kind: 'problem', text: t('github.err.apiLeg'), again: true, useToken: true });
        return;
      }
      if (ctl.signal.aborted) return;
      if (outcome.outcome !== 'signedIn') {
        setPhase(problemOf(outcome));
        return;
      }
      const account: Account = { login: outcome.login, id: outcome.id, avatarUrl: outcome.avatarUrl };
      setPhase({ kind: 'done', login: outcome.login });
      doneTimer = setTimeout(() => {
        if (!ctl.signal.aborted) latest.current.onSignedIn(account);
      }, latest.current.doneDelayMs ?? 1000);
    };
    // StrictMode 의 시험 삼아 다시 붙이기에서 코드를 두 번 받지 않도록 한 박자 늦게 시작한다(떼면 타이머를 지운다).
    const kick = setTimeout(() => void run(), 0);
    return () => {
      clearTimeout(kick);
      if (doneTimer) clearTimeout(doneTimer);
      ctl.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [round]);

  // 남은 시간을 1초마다 다시 그린다.
  useEffect(() => {
    if (phase.kind !== 'code') return;
    const timer = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [phase.kind]);

  const cancel = () => {
    abort.current?.abort();
    props.onCancel();
  };

  return (
    <div className="github-signin" aria-live="polite">
      <p className="github-signin-title">{t('github.signin.title')}</p>
      <p className="prompt-hint">{t('github.signin.what')}</p>
      {phase.kind === 'starting' ? <p className="prompt-hint">{t('github.progress.checking')}</p> : null}
      {phase.kind === 'code' ? (
        <>
          <p>{t('github.signin.enterCode')}</p>
          <div className="github-code-row">
            <code className="github-code">{phase.userCode}</code>
            {phase.copied ? <span className="github-copied">{t('github.signin.copied')}</span> : null}
            <button type="button" onClick={() => void props.deps.copy(phase.userCode).catch(() => undefined)}>
              <Icon name="copy" size={14} />
              <span>{t('github.signin.copy')}</span>
            </button>
          </div>
          <div className="github-actions">
            <button type="button" onClick={() => void Promise.resolve(props.deps.openExternal(phase.verificationUri)).catch(() => undefined)}>
              <Icon name="external-link" size={14} />
              <span>{t('github.signin.reopen')}</span>
            </button>
          </div>
          <div className="github-actions">
            <span className="prompt-hint">{t('github.signin.waiting', remaining(phase.deadline - now()))}</span>
            <button type="button" onClick={cancel}>
              {t('dialog.cancel')}
            </button>
          </div>
        </>
      ) : null}
      {phase.kind === 'done' ? <p className="github-signin-done">{t('github.signin.done', phase.login)}</p> : null}
      {phase.kind === 'problem' ? (
        <>
          {phase.text ? (
            <p role="alert" className="prompt-hint warn">
              {phase.text}
            </p>
          ) : null}
          <div className="github-actions">
            {phase.again ? (
              <button type="button" onClick={() => setRound((r) => r + 1)}>
                {t('github.signin.newCode')}
              </button>
            ) : null}
            <button type="button" onClick={cancel}>
              {t('dialog.cancel')}
            </button>
          </div>
        </>
      ) : null}
      {phase.kind === 'starting' ? (
        <div className="github-actions">
          <button type="button" onClick={cancel}>
            {t('dialog.cancel')}
          </button>
        </div>
      ) : null}
      <p className="prompt-hint">{t('github.signin.noPassword')}</p>
      <div className="github-actions">
        <span className="prompt-hint">{t('github.signin.noAccount')}</span>
        <button type="button" className="github-link" onClick={() => void Promise.resolve(props.deps.openExternal(GITHUB_SIGNUP_URL)).catch(() => undefined)}>
          {t('github.signin.signup')}
        </button>
      </div>
      {props.onUseToken && phase.kind !== 'done' ? (
        <div className="github-actions">
          <button type="button" className="github-link" onClick={() => props.onUseToken?.()}>
            {t('github.signin.useToken')}
          </button>
        </div>
      ) : null}
    </div>
  );
}
