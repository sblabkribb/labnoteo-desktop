import { t } from '../i18n/t';
import { useLang } from '../i18n/useLang';
import { DialogFrame } from '../labnote/host/DialogFrame';
import type { DialogSpec } from '../labnote/host/dialogStore';
import { SignInPanel, type SignInPanelDeps } from './SignInPanel';

/** 로그인 대화상자의 답: 연결됨, 닫음, "토큰으로 연결 (고급)". */
export type SignInResult = 'ok' | 'cancel' | 'useToken';

export type SignInSpec = { kind: 'githubSignIn'; deps: SignInPanelDeps; doneDelayMs?: number };

/**
 * spec §5.2 화면 A 를 올리기 흐름의 줄 선 대화상자로 보인다. 몸통은 설정의 GitHub 묶음과 같은 `SignInPanel` 이다.
 * 연결되면 1초 뒤에 저절로 'ok' 로 닫힌다. "토큰으로 연결" 은 이 대화상자를 닫고(흐름이 끝난다) 흐름이 설정을 연다.
 */
export function SignInDialog(props: {
  spec: Extract<DialogSpec, { kind: 'githubSignIn' }>;
  onDone: (value: SignInResult) => void;
  onCancel: () => void;
}) {
  useLang();
  return (
    <DialogFrame title={t('github.signin.title')} className="github-dialog" onCancel={props.onCancel}>
      <SignInPanel
        deps={props.spec.deps}
        hideTitle
        doneDelayMs={props.spec.doneDelayMs}
        onSignedIn={() => props.onDone('ok')}
        onCancel={props.onCancel}
        onUseToken={() => props.onDone('useToken')}
      />
    </DialogFrame>
  );
}
