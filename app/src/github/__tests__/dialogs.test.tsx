// @vitest-environment jsdom
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { setLang } from '../../i18n/lang';
import { t } from '../../i18n/t';
import {
  currentDialog,
  githubDestinationDialog,
  githubSignInDialog,
  openDialog,
} from '../../labnote/host/dialogStore';
import { cleanupDialogs, openIn, renderLayer, styleAttributes } from '../../labnote/host/__tests__/harness';
import type { Account, NameCheck, OwnersOutcome, ResolveOutcome } from '../../integrations/githubIpc';
import type { SettingsDeps } from '../../ui/SettingsModal';
import type { DestinationDeps, DestinationInit } from '../UploadDialog';

const ME: Account = { login: 'parkyaeseong', id: 1, avatarUrl: '' };
/** 한국어 화면에 쓰지 않는 말(spec §10). */
const FORBIDDEN = ['브랜치', '커밋', '푸시', '소유자'];

beforeEach(() => setLang('ko'));
afterEach(() => cleanupDialogs());

function init(over: Partial<DestinationInit> = {}): DestinationInit {
  return { title: '단백질 발현', folderName: '001_단백질_발현', account: ME, slug: '001_danbaekjil_balhyeon', ...over };
}

function destDeps(o: { owners?: OwnersOutcome; check?: (owner: string, name: string) => NameCheck; resolve?: ResolveOutcome } = {}) {
  const checks: Array<[string, string]> = [];
  const deps: DestinationDeps = {
    nameCheckDelayMs: 0,
    owners: async () =>
      o.owners ?? {
        outcome: 'ok',
        owners: [
          { login: ME.login, kind: 'user' },
          { login: 'kim-lab', kind: 'org' },
        ],
        orgsListed: true,
      },
    nameCheck: async (owner, name) => {
      checks.push([owner, name]);
      return o.check ? o.check(owner, name) : { outcome: 'free' };
    },
    resolveRepo: async () => o.resolve ?? { outcome: 'invalidUrl' },
  };
  return { deps, checks };
}

function koText(): string {
  return document.querySelector('.dialog-layer')?.textContent ?? '';
}

describe('sign-in dialog', () => {
  it('shows the code in a queued dialog and closes with "ok" once signed in', async () => {
    renderLayer();
    const p = openIn(() =>
      githubSignInDialog(
        {
          signInStart: async () => ({ outcome: 'started', userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device', expiresIn: 900 }),
          signInWait: async () => ({ outcome: 'signedIn', login: 'octo', id: 7, avatarUrl: '' }),
          openExternal: async () => undefined,
          copy: async () => undefined,
        },
        { doneDelayMs: 0 },
      ),
    );
    expect(screen.getByRole('dialog', { name: t('github.signin.title') })).toBeTruthy();
    await expect(p).resolves.toBe('ok');
  });

  it('"connect with a token" answers useToken', async () => {
    renderLayer();
    const p = openIn(() =>
      githubSignInDialog({
        signInStart: async () => ({ outcome: 'notConfigured' }),
        signInWait: async () => ({ outcome: 'cancelled' }),
        openExternal: async () => undefined,
        copy: async () => undefined,
      }),
    );
    expect(await screen.findByText(t('github.signin.notConfigured'))).toBeTruthy();
    expect(FORBIDDEN.filter((w) => koText().includes(w))).toEqual([]);
    expect(styleAttributes()).toEqual([]);
    await userEvent.click(screen.getByRole('button', { name: t('github.signin.useToken') }));
    await expect(p).resolves.toBe('useToken');
  });
});

describe('destination dialog', () => {
  it('prefills the name, checks it, and answers a private create', async () => {
    renderLayer();
    const { deps, checks } = destDeps();
    const p = openIn(() => githubDestinationDialog(init(), deps));
    expect(screen.getByRole('dialog', { name: t('github.dest.title', '단백질 발현') })).toBeTruthy();
    expect((screen.getByLabelText(t('github.dest.name')) as HTMLInputElement).value).toBe('001_danbaekjil_balhyeon');
    expect(screen.getByText(t('github.dest.private'))).toBeTruthy();
    expect(await screen.findByText(t('github.dest.free'))).toBeTruthy();
    expect(checks.at(-1)).toEqual([ME.login, '001_danbaekjil_balhyeon']);
    expect(FORBIDDEN.filter((w) => koText().includes(w))).toEqual([]);
    expect(styleAttributes()).toEqual([]);
    await userEvent.click(screen.getByRole('button', { name: t('github.dest.next') }));
    await expect(p).resolves.toEqual({ kind: 'create', owner: ME.login, name: '001_danbaekjil_balhyeon', private: true });
  });

  it('an org owner switches the name to {login}-{slug} and shows dest.privateOrg', async () => {
    renderLayer();
    const { deps } = destDeps();
    void openIn(() => githubDestinationDialog(init(), deps));
    await screen.findByRole('option', { name: 'kim-lab' });
    await userEvent.selectOptions(screen.getByLabelText(t('github.dest.where')), 'kim-lab');
    expect((screen.getByLabelText(t('github.dest.name')) as HTMLInputElement).value).toBe('parkyaeseong-001_danbaekjil_balhyeon');
    expect(screen.getByText(t('github.dest.privateOrg'))).toBeTruthy();
    expect(screen.queryByText(t('github.dest.private'))).toBeNull();
  });

  it('an edited name is kept when the owner changes', async () => {
    renderLayer();
    const { deps } = destDeps();
    void openIn(() => githubDestinationDialog(init(), deps));
    await screen.findByRole('option', { name: 'kim-lab' });
    const name = screen.getByLabelText(t('github.dest.name'));
    await userEvent.clear(name);
    await userEvent.type(name, 'my-repo');
    await userEvent.selectOptions(screen.getByLabelText(t('github.dest.where')), 'kim-lab');
    expect((name as HTMLInputElement).value).toBe('my-repo');
  });

  it('the public button stays disabled until the exact name is typed', async () => {
    renderLayer();
    const { deps } = destDeps();
    const p = openIn(() => githubDestinationDialog(init(), deps));
    await screen.findByText(t('github.dest.free'));
    await userEvent.click(screen.getByRole('button', { name: t('github.dest.makePublic') }));
    const confirm = screen.getByRole('button', { name: t('github.public.confirm') }) as HTMLButtonElement;
    const typed = screen.getByRole('textbox', { name: t('github.public.confirm') });
    expect(confirm.disabled).toBe(true);
    await userEvent.type(typed, '001_danbaekjil_balhyeo');
    expect(confirm.disabled).toBe(true);
    await userEvent.type(typed, 'N');
    expect(confirm.disabled).toBe(true);
    await userEvent.type(typed, '{Backspace}n');
    expect(confirm.disabled).toBe(false);
    expect(FORBIDDEN.filter((w) => koText().includes(w))).toEqual([]);
    await userEvent.click(confirm);
    await expect(p).resolves.toEqual({
      kind: 'create',
      owner: ME.login,
      name: '001_danbaekjil_balhyeon',
      private: false,
      publicConfirm: '001_danbaekjil_balhyeon',
    });
  });

  it('a taken name offers "use this repository" and "change the name"', async () => {
    renderLayer();
    const { deps } = destDeps({
      check: (_o, name) => (name === '001_danbaekjil_balhyeon' ? { outcome: 'taken', repoId: 9, empty: true, private: true, canPush: true } : { outcome: 'free' }),
    });
    const p = openIn(() => githubDestinationDialog(init(), deps));
    expect(await screen.findByText(t('github.dest.taken'))).toBeTruthy();
    expect((screen.getByRole('button', { name: t('github.dest.next') }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: t('github.dest.rename') }));
    expect((screen.getByLabelText(t('github.dest.name')) as HTMLInputElement).value).toBe('001_danbaekjil_balhyeon-2');
    expect(await screen.findByText(t('github.dest.free'))).toBeTruthy();
    await userEvent.clear(screen.getByLabelText(t('github.dest.name')));
    await userEvent.type(screen.getByLabelText(t('github.dest.name')), '001_danbaekjil_balhyeon');
    await screen.findByText(t('github.dest.taken'));
    await userEvent.click(screen.getByRole('button', { name: t('github.dest.linkThis') }));
    await expect(p).resolves.toEqual({ kind: 'link', owner: ME.login, name: '001_danbaekjil_balhyeon' });
  });

  it('linking an existing private repository by address', async () => {
    renderLayer();
    const { deps } = destDeps({
      resolve: { outcome: 'ok', owner: 'kim-lab', name: 'shared', repoId: 3, private: true, empty: false, canPush: true, defaultBranch: 'main' },
    });
    const p = openIn(() => githubDestinationDialog(init({ mode: 'link' }), deps));
    await userEvent.type(screen.getByLabelText(t('github.dest.linkUrl')), 'https://github.com/kim-lab/shared');
    await userEvent.click(screen.getByRole('button', { name: t('github.dest.next') }));
    await expect(p).resolves.toEqual({ kind: 'link', owner: 'kim-lab', name: 'shared' });
  });

  it('a read-only repository cannot be linked', async () => {
    renderLayer();
    const { deps } = destDeps({
      resolve: { outcome: 'ok', owner: 'kim-lab', name: 'shared', repoId: 3, private: true, empty: false, canPush: false, defaultBranch: 'main' },
    });
    void openIn(() => githubDestinationDialog(init({ mode: 'link' }), deps));
    await userEvent.type(screen.getByLabelText(t('github.dest.linkUrl')), 'kim-lab/shared');
    await userEvent.click(screen.getByRole('button', { name: t('github.dest.next') }));
    expect(await screen.findByText(t('github.err.readOnly'))).toBeTruthy();
  });

  it('a preset owner from "upload to my account" is preselected', async () => {
    renderLayer();
    const { deps } = destDeps();
    void openIn(() => githubDestinationDialog(init({ defaultOwner: 'kim-lab', owner: ME.login }), deps));
    await waitFor(() => expect((screen.getByLabelText(t('github.dest.where')) as HTMLSelectElement).value).toBe(ME.login));
    expect((screen.getByLabelText(t('github.dest.name')) as HTMLInputElement).value).toBe('001_danbaekjil_balhyeon');
  });
});

describe('the dialog queue', () => {
  it('flow dialogs wait behind the settings modal instead of stacking', async () => {
    const settings = openDialog<undefined>({ kind: 'settings', page: 'integrations', deps: {} as SettingsDeps }, undefined);
    const { deps } = destDeps();
    let dest!: Promise<unknown>;
    act(() => {
      dest = githubDestinationDialog(init(), deps);
    });
    expect(currentDialog()?.spec.kind).toBe('settings');
    cleanupDialogs();
    await expect(settings).resolves.toBeUndefined();
    await expect(dest).resolves.toBe('cancel');
  });
});
