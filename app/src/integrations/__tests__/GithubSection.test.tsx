// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { setLang } from '../../i18n/lang';
import { t } from '../../i18n/t';
import { styleAttributes } from '../../labnote/host/__tests__/harness';
import { fromPluginData } from '../../labnote/settings';
import { GithubSection, revokeUrl, type GithubDeps } from '../GithubSection';
import { EMPTY_STATUS, IntegrationSettingsPage, type IntegrationDeps, type IntegrationSettingsValue } from '../IntegrationSettingsDialog';
import type { Account, FolderStatus, GithubAppSettings, OwnersOutcome, SignInOutcome, SignInStart, TokenOutcome } from '../githubIpc';
import { NetError, type SecretStatus } from '../netIpc';
import { fakeInvoke, secretStatusOf } from './fakeNet';

beforeEach(() => setLang('ko'));
afterEach(() => cleanup());

/** 가짜 토큰 모양(진짜가 아니다). 화면에 절대 나오면 안 된다. */
const FAKE_TOKEN = 'ghp_FAKEsettings000000000000000000000000';

type Fake = GithubDeps & {
  calls: string[];
  signOut: ReturnType<typeof vi.fn>;
  unlink: ReturnType<typeof vi.fn>;
  openExternal: ReturnType<typeof vi.fn>;
  setToken: ReturnType<typeof vi.fn>;
  setAppSettings: ReturnType<typeof vi.fn>;
  setDefaultOwner: ReturnType<typeof vi.fn>;
  commitReadmeOverlay: ReturnType<typeof vi.fn>;
  copy: ReturnType<typeof vi.fn>;
  resolveWait(o: SignInOutcome): void;
};

function fake(opts: {
  account?: Account | null;
  start?: SignInStart;
  token?: TokenOutcome;
  statuses?: Record<string, FolderStatus>;
  app?: GithubAppSettings;
  owners?: OwnersOutcome;
} = {}): Fake {
  let account: Account | null = opts.account ?? null;
  let app: GithubAppSettings = opts.app ?? { clientIdDefault: true, forgetOnExit: false };
  let statuses = opts.statuses ?? {};
  let readme = true;
  let tokenSet = account !== null;
  const calls: string[] = [];
  let waitResolve: ((o: SignInOutcome) => void) | undefined;
  const f: Fake = {
    calls,
    account: async () => account,
    secretStatus: async (): Promise<SecretStatus> => secretStatusOf({ github: tokenSet }),
    signInStart: async () => {
      calls.push('start');
      return opts.start ?? { outcome: 'started', userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device', expiresIn: 900 };
    },
    signInWait: (signal: AbortSignal) =>
      new Promise<SignInOutcome>((resolve, reject) => {
        calls.push('wait');
        waitResolve = (o) => {
          if (o.outcome === 'signedIn') {
            account = { login: o.login, id: o.id, avatarUrl: o.avatarUrl };
            tokenSet = true;
          }
          resolve(o);
        };
        signal.addEventListener('abort', () => {
          calls.push('abort');
          reject(new NetError('cancelled', 'cancelled'));
        });
      }),
    resolveWait: (o) => waitResolve?.(o),
    signOut: vi.fn(async () => {
      account = null;
      tokenSet = false;
    }),
    setToken: vi.fn(async (_v: string) => {
      const r = opts.token ?? { outcome: 'saved', login: 'octo', fineGrained: false };
      if (r.outcome === 'saved') {
        account = { login: r.login, id: 1, avatarUrl: '' };
        tokenSet = true;
      }
      return r;
    }),
    statuses: async () => statuses,
    unlink: vi.fn(async (folder: string) => {
      const next = { ...statuses };
      delete next[folder];
      statuses = next;
    }),
    openExternal: vi.fn(async () => undefined),
    copy: vi.fn(async () => undefined),
    appSettings: async () => app,
    setAppSettings: vi.fn(async (patch) => {
      app = { ...app, ...patch } as GithubAppSettings;
      if ('clientId' in patch) {
        app = { clientId: patch.clientId ?? undefined, clientIdDefault: !patch.clientId, forgetOnExit: app.forgetOnExit };
      }
      return app;
    }),
    readmeOverlay: () => readme,
    commitReadmeOverlay: vi.fn(async (v: boolean) => {
      readme = v;
    }),
    owners: async () =>
      opts.owners ?? {
        outcome: 'ok',
        owners: [
          { login: account?.login ?? 'octo', kind: 'user' },
          { login: 'sblab', kind: 'org' },
        ],
        orgsListed: true,
      },
    defaultOwner: async () => undefined,
    setDefaultOwner: vi.fn(async () => undefined),
  };
  return f;
}

const LINKED: Record<string, FolderStatus> = {
  '실험/PCR 2026-11-10': {
    linked: true,
    private: true,
    state: 'pushed',
    changedCount: 2,
    fullName: 'octo/pcr-2026-11-10',
    htmlUrl: 'https://github.com/octo/pcr-2026-11-10',
    folderMissing: false,
  },
};

function show(deps: GithubDeps, focus?: 'githubToken') {
  return render(<GithubSection deps={deps} onLeave={async () => {}} focus={focus} />);
}

const section = () => within(screen.getByRole('region', { name: 'GitHub' }));

describe('GithubSection', () => {
  it('signed out: shows the connect button and no visibility setting', async () => {
    show(fake());
    expect(await section().findByRole('button', { name: t('github.settings.connect') })).toBeTruthy();
    expect(screen.queryByText(t('github.settings.signOut'))).toBeNull();
    // 공개 여부 기본값 설정은 없다(spec §9)
    expect(screen.queryByText(/공개|visibility|public/i)).toBeNull();
    expect(styleAttributes()).toEqual([]);
  });

  it('signed in: shows @login; sign out calls signOut, then the revoke note opens GitHub settings for the client ID', async () => {
    const deps = fake({ account: { login: 'octo', id: 1, avatarUrl: '' }, app: { clientId: 'Iv1.abc123', clientIdDefault: false, forgetOnExit: false } });
    show(deps);
    expect(await section().findByText('@octo')).toBeTruthy();
    await userEvent.click(section().getByRole('button', { name: t('github.settings.signOut') }));
    expect(deps.signOut).toHaveBeenCalledTimes(1);
    expect(await section().findByText(t('github.signout.cannotRevoke'))).toBeTruthy();
    expect(section().getByText(t('github.signout.revoke'))).toBeTruthy();
    await userEvent.click(section().getByRole('button', { name: t('github.signout.revokeOpen') }));
    expect(deps.openExternal).toHaveBeenCalledWith('https://github.com/settings/connections/applications/Iv1.abc123');
    // 로그아웃 뒤에는 다시 연결 단추
    expect(section().getByRole('button', { name: t('github.settings.connect') })).toBeTruthy();
  });

  it('revokeUrl uses the client ID, or GitHub’s app list when only the built-in default is known', () => {
    expect(revokeUrl('Iv1.abc')).toBe('https://github.com/settings/connections/applications/Iv1.abc');
    expect(revokeUrl(undefined)).toBe('https://github.com/settings/applications');
    expect(revokeUrl('bad/id')).toBe('https://github.com/settings/applications');
  });

  it('a fine-grained token shows settings.tokenFineGrained and never renders the token', async () => {
    const deps = fake({ token: { outcome: 'saved', login: 'octo', fineGrained: true } });
    show(deps);
    await userEvent.click(await section().findByRole('button', { name: t('github.settings.advanced') }));
    const input = section().getByLabelText(t('github.settings.token')) as HTMLInputElement;
    expect(input.type).toBe('password');
    fireEvent.change(input, { target: { value: FAKE_TOKEN } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(deps.setToken).toHaveBeenCalledWith(FAKE_TOKEN));
    expect(await section().findByText(t('github.settings.tokenFineGrained'))).toBeTruthy();
    expect(await section().findByText('@octo')).toBeTruthy();
    expect(input.value).toBe('');
    expect(document.body.innerHTML).not.toContain(FAKE_TOKEN);
  });

  it('a token in the wrong form shows the bad-token line', async () => {
    const deps = fake({ token: { outcome: 'badToken' } });
    show(deps);
    await userEvent.click(await section().findByRole('button', { name: t('github.settings.advanced') }));
    const input = section().getByLabelText(t('github.settings.token')) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'nope' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(await section().findByText(t('github.import.badToken'))).toBeTruthy();
  });

  it('unlink asks inline with unlink.confirm, then calls unlink', async () => {
    const deps = fake({ account: { login: 'octo', id: 1, avatarUrl: '' }, statuses: LINKED });
    show(deps);
    expect(await section().findByText('octo/pcr-2026-11-10')).toBeTruthy();
    expect(section().getByText('PCR 2026-11-10')).toBeTruthy();
    expect(section().getByText(t('github.status.changed', 2))).toBeTruthy();
    await userEvent.click(section().getByRole('button', { name: t('github.menu.open') }));
    expect(deps.openExternal).toHaveBeenCalledWith('https://github.com/octo/pcr-2026-11-10');
    await userEvent.click(section().getByRole('button', { name: t('github.unlink.title') }));
    expect(section().getByText(t('github.unlink.confirm'))).toBeTruthy();
    expect(deps.unlink).not.toHaveBeenCalled();
    await userEvent.click(section().getByRole('button', { name: t('dialog.cancel') }));
    expect(section().queryByText(t('github.unlink.confirm'))).toBeNull();
    await userEvent.click(section().getByRole('button', { name: t('github.unlink.title') }));
    const confirmRow = within(section().getByText(t('github.unlink.confirm')).closest('.github-confirm') as HTMLElement);
    await userEvent.click(confirmRow.getByRole('button', { name: t('github.unlink.title') }));
    expect(deps.unlink).toHaveBeenCalledWith('실험/PCR 2026-11-10');
    await waitFor(() => expect(section().queryByText('octo/pcr-2026-11-10')).toBeNull());
  });

  it('toggles: README overlay commits the vault setting, forget-on-exit the app-wide one', async () => {
    const deps = fake({ account: { login: 'octo', id: 1, avatarUrl: '' } });
    show(deps);
    const readme = await section().findByRole('switch', { name: t('github.settings.readme') });
    expect(readme.getAttribute('aria-checked')).toBe('true');
    await userEvent.click(readme);
    expect(deps.commitReadmeOverlay).toHaveBeenCalledWith(false);
    const forget = section().getByRole('switch', { name: t('github.settings.forgetOnExit') });
    await waitFor(() => expect(forget.getAttribute('aria-checked')).toBe('false'));
    await userEvent.click(forget);
    expect(deps.setAppSettings).toHaveBeenCalledWith({ forgetOnExit: true });
    await waitFor(() => expect(forget.getAttribute('aria-checked')).toBe('true'));
  });

  it('default upload location lists my account and the orgs, and saves the choice', async () => {
    const deps = fake({ account: { login: 'octo', id: 1, avatarUrl: '' } });
    show(deps);
    const select = (await section().findByRole('combobox', { name: t('github.settings.defaultOwner') })) as HTMLSelectElement;
    await waitFor(() => expect([...select.options].map((o) => o.textContent)).toEqual([t('github.dest.mine', 'octo'), 'sblab']));
    fireEvent.change(select, { target: { value: 'sblab' } });
    await waitFor(() => expect(deps.setDefaultOwner).toHaveBeenCalledWith('sblab'));
  });

  it('client ID: the placeholder says the default is in use; a new value is saved on Enter', async () => {
    const deps = fake();
    show(deps);
    await userEvent.click(await section().findByRole('button', { name: t('github.settings.advanced') }));
    const input = section().getByLabelText(t('github.settings.clientId')) as HTMLInputElement;
    expect(input.placeholder).toBe(t('github.settings.clientIdDefault'));
    fireEvent.change(input, { target: { value: 'Iv1.new' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(deps.setAppSettings).toHaveBeenCalledWith({ clientId: 'Iv1.new' }));
  });

  it('connect shows the sign-in code inline (copied, browser opened) and a successful wait shows @login', async () => {
    const deps = fake();
    show(deps);
    await userEvent.click(await section().findByRole('button', { name: t('github.settings.connect') }));
    expect(await section().findByText('ABCD-1234')).toBeTruthy();
    expect(deps.copy).toHaveBeenCalledWith('ABCD-1234');
    expect(deps.openExternal).toHaveBeenCalledWith('https://github.com/login/device');
    expect(section().getByText(t('github.signin.waiting', '15:00'))).toBeTruthy();
    await waitFor(() => expect(deps.calls).toContain('wait'));
    await act(async () => deps.resolveWait({ outcome: 'signedIn', login: 'octo', id: 1, avatarUrl: '' }));
    expect(await section().findByText('@octo', {}, { timeout: 3000 })).toBeTruthy();
    expect(styleAttributes()).toEqual([]);
  });

  it('cancel aborts the wait (net_cancel through the signal) and goes back to the connect button', async () => {
    const deps = fake();
    show(deps);
    await userEvent.click(await section().findByRole('button', { name: t('github.settings.connect') }));
    await section().findByText('ABCD-1234');
    await waitFor(() => expect(deps.calls).toContain('wait'));
    await userEvent.click(section().getByRole('button', { name: t('dialog.cancel') }));
    expect(deps.calls).toContain('abort');
    expect(await section().findByRole('button', { name: t('github.settings.connect') })).toBeTruthy();
  });

  it('no client ID: the panel says so and "connect with a token" opens the advanced part with the token field focused', async () => {
    const deps = fake({ start: { outcome: 'notConfigured' } });
    show(deps);
    await userEvent.click(await section().findByRole('button', { name: t('github.settings.connect') }));
    expect(await section().findByText(t('github.signin.notConfigured'))).toBeTruthy();
    await userEvent.click(section().getByRole('button', { name: t('github.signin.useToken') }));
    await waitFor(() => expect(document.activeElement).toBe(section().getByLabelText(t('github.settings.token'))));
  });

  it('focus "githubToken" opens the advanced part and focuses the token field', async () => {
    show(fake(), 'githubToken');
    await waitFor(() => expect(document.activeElement).toBe(section().getByLabelText(t('github.settings.token'))));
  });

  it('every call failing (offline) still renders the section', async () => {
    const fail = async () => {
      throw new NetError('offline', 'raw-rust-text');
    };
    const deps = { ...fake(), account: fail, secretStatus: fail, statuses: fail, appSettings: fail, owners: fail, defaultOwner: fail } as GithubDeps;
    show(deps);
    expect(await section().findByRole('button', { name: t('github.settings.connect') })).toBeTruthy();
    expect(document.body.textContent).not.toContain('raw-rust-text');
  });

  it('EMPTY_STATUS round-trips through JSON and covers both GitHub slots', () => {
    expect(JSON.parse(JSON.stringify(EMPTY_STATUS))).toEqual(secretStatusOf({}));
    expect(EMPTY_STATUS.set.github).toBe(false);
    expect(EMPTY_STATUS.set.githubRefresh).toBe(false);
  });
});

describe('IntegrationSettingsPage with GitHub', () => {
  const BASE: IntegrationSettingsValue = (() => {
    const s = fromPluginData(undefined);
    return {
      partbankDesktopUrl: s.partbankDesktopUrl,
      partbankWebUrl: s.partbankWebUrl,
      partbankDefaultConnection: s.partbankDefaultConnection,
      partbankSendUsages: s.partbankSendUsages,
      llmProvider: s.llmProvider,
      llmEndpointOllama: s.llmEndpointOllama,
      llmEndpointOpenai: s.llmEndpointOpenai,
      llmModel: s.llmModel,
      bfwUrl: s.bfwUrl,
      bfwConnection: s.bfwConnection,
      allowHttpOrigins: s.allowHttpOrigins,
      worksheetPaperSize: s.worksheetPaperSize,
      scanMaxImageEdge: s.scanMaxImageEdge,
      scanJpegQuality: s.scanJpegQuality,
      scanEmbedWidth: s.scanEmbedWidth,
      mcpEnabled: s.mcpEnabled,
      mcpPort: s.mcpPort,
    };
  })();

  it('renders the GitHub section last, after the MCP and skill sections', async () => {
    const { invoke } = fakeInvoke({});
    const deps: IntegrationDeps = {
      value: () => BASE,
      commit: async () => undefined,
      status: async () => secretStatusOf({}),
      setSecret: async () => undefined,
      clearSecret: async () => undefined,
      mcp: { notify: () => undefined, invoke },
      github: fake(),
    };
    render(<IntegrationSettingsPage deps={deps} onLeave={async () => {}} />);
    await screen.findByRole('button', { name: t('github.settings.connect') });
    const sections = [...document.querySelectorAll('section.integration-section')];
    const last = sections[sections.length - 1];
    expect(last.classList.contains('github-section')).toBe(true);
    const mcp = document.querySelector('section.mcp-section')!;
    const skill = document.querySelector('section.skill-section')!;
    expect(mcp.compareDocumentPosition(last) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(skill.compareDocumentPosition(last) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('without deps.github there is no GitHub section', async () => {
    const deps: IntegrationDeps = {
      value: () => BASE,
      commit: async () => undefined,
      status: async () => secretStatusOf({}),
      setSecret: async () => undefined,
      clearSecret: async () => undefined,
    };
    render(<IntegrationSettingsPage deps={deps} onLeave={async () => {}} />);
    await act(async () => {});
    expect(document.querySelector('.github-section')).toBeNull();
  });
});
