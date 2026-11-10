// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { setLang } from '../../i18n/lang';
import { t } from '../../i18n/t';
import { styleAttributes } from '../../labnote/host/__tests__/harness';
import type { SignInOutcome } from '../../integrations/githubIpc';
import { GITHUB_SIGNUP_URL, SignInPanel, remaining, type SignInPanelDeps } from '../SignInPanel';

beforeEach(() => setLang('ko'));
afterEach(() => cleanup());

function deps(outcomes: SignInOutcome[]): SignInPanelDeps & { starts: number; openExternal: ReturnType<typeof vi.fn> } {
  const d = {
    starts: 0,
    signInStart: async () => {
      d.starts += 1;
      return { outcome: 'started' as const, userCode: `CODE-${d.starts}`, verificationUri: 'https://github.com/login/device', expiresIn: 600 };
    },
    signInWait: async () => outcomes.shift() ?? { outcome: 'cancelled' as const },
    openExternal: vi.fn(async () => undefined),
    copy: async () => undefined,
  };
  return d;
}

describe('SignInPanel', () => {
  it('formats the time left as m:ss', () => {
    expect(remaining(900_000)).toBe('15:00');
    expect(remaining(61_500)).toBe('1:02');
    expect(remaining(-5)).toBe('0:00');
  });

  it('an expired code offers a new one, which starts the device flow again', async () => {
    const d = deps([{ outcome: 'expired' }, { outcome: 'denied' }]);
    render(<SignInPanel deps={d} onSignedIn={() => undefined} onCancel={() => undefined} />);
    expect(await screen.findByText(t('github.signin.expired'))).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: t('github.signin.newCode') }));
    expect(await screen.findByText(t('github.signin.denied'))).toBeTruthy();
    expect(d.starts).toBe(2);
    expect(styleAttributes()).toEqual([]);
  });

  it('a signed-in result shows @login and then calls onSignedIn', async () => {
    const d = deps([{ outcome: 'signedIn', login: 'octo', id: 7, avatarUrl: '' }]);
    const onSignedIn = vi.fn();
    render(<SignInPanel deps={d} onSignedIn={onSignedIn} onCancel={() => undefined} doneDelayMs={0} />);
    expect(await screen.findByText(t('github.signin.done', 'octo'))).toBeTruthy();
    await waitFor(() => expect(onSignedIn).toHaveBeenCalledWith({ login: 'octo', id: 7, avatarUrl: '' }));
  });

  it('sign up opens GitHub’s sign-up page; no token button without onUseToken', async () => {
    const d = deps([]);
    render(<SignInPanel deps={d} onSignedIn={() => undefined} onCancel={() => undefined} />);
    await userEvent.click(screen.getByRole('button', { name: t('github.signin.signup') }));
    expect(d.openExternal).toHaveBeenCalledWith(GITHUB_SIGNUP_URL);
    expect(screen.queryByRole('button', { name: t('github.signin.useToken') })).toBeNull();
  });
});
