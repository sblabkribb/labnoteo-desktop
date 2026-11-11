// @vitest-environment jsdom
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { setLang } from '../../i18n/lang';
import { t } from '../../i18n/t';
import {
  choiceDialog,
  currentDialog,
  githubDestinationDialog,
  githubDivergedDialog,
  githubPreviewDialog,
  githubQuickDialog,
  githubSignInDialog,
  openDialog,
} from '../../labnote/host/dialogStore';
import { cleanupDialogs, openIn, renderLayer, styleAttributes } from '../../labnote/host/__tests__/harness';
import type { Account, NameCheck, OwnersOutcome, ResolveOutcome, UploadChoices } from '../../integrations/githubIpc';
import { showDone, type ReadyPlan } from '../githubFlow';
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

function plan(over: Partial<ReadyPlan> = {}): ReadyPlan {
  return {
    outcome: 'ready',
    planId: 'p1',
    mode: 'first',
    files: [
      { path: 'README.labnote.md', size: 1200, change: 'new' },
      { path: 'images/bench.jpg', size: 4096, change: 'new' },
      { path: 'README.md', size: 300, change: 'new', generated: true },
    ],
    excluded: [{ path: '.env', reason: 'hard' }],
    red: [],
    yellow: [],
    samples: [],
    totals: { files: 3, generated: 1, bytes: 5596, excluded: 1, new: 3, changed: 0, deleted: 0 },
    quickOk: false,
    ...over,
  };
}

const HEAD = { folder: 'labnote/001_단백질_발현', title: '단백질 발현', fullName: 'parkyaeseong/001_danbaekjil_balhyeon', private: true };

describe('preview dialog', () => {
  it('lists files grouped by folder with only checkboxes that leave files out; nothing adds a path', async () => {
    renderLayer();
    const p = openIn(() => githubPreviewDialog(plan(), HEAD, { openFile: () => undefined }));
    const dialog = screen.getByRole('dialog', { name: t('github.preview.title') });
    expect(dialog.querySelectorAll('fieldset legend')).toHaveLength(2);
    const inputs = [...dialog.querySelectorAll('input')];
    expect(inputs.every((i) => i.type === 'checkbox')).toBe(true);
    // the generated README cannot be left out: only the two real files have a checkbox
    expect(inputs).toHaveLength(2);
    expect(dialog.querySelector('input[type=file], textarea')).toBeNull();
    expect(FORBIDDEN.filter((w) => koText().includes(w))).toEqual([]);
    expect(styleAttributes()).toEqual([]);
    await userEvent.click(screen.getByRole('checkbox', { name: 'bench.jpg' }));
    await userEvent.click(screen.getByRole('button', { name: t('github.preview.upload') }));
    await expect(p).resolves.toEqual({ untick: ['images/bench.jpg'], allowHits: [], includeSamples: false });
  });

  it('many findings scroll inside the body while the Cancel / Upload row stays outside it', () => {
    renderLayer();
    const hits = Array.from({ length: 7 }, (_, i) => ({ kind: 'tooLarge' as const, path: `raw/big_${i}.czi`, size: 101 * 1024 * 1024 }));
    void openIn(() => githubPreviewDialog(plan({ red: hits, excluded: hits.map((h) => ({ path: h.path, reason: 'tooLarge' as const })) }), HEAD, { openFile: () => undefined }));
    const dialog = screen.getByRole('dialog', { name: t('github.preview.title') });
    const body = dialog.querySelector('.github-form')!;
    const actions = screen.getByRole('button', { name: t('github.preview.upload') }).closest('.dialog-actions')!;
    expect(body).not.toBeNull();
    expect(actions).not.toBeNull();
    expect(body.contains(actions)).toBe(false);
    expect(body.querySelector('.github-red')).not.toBeNull();
  });

  it('a red item disables Upload until the file is left out', async () => {
    renderLayer();
    const p = openIn(() =>
      githubPreviewDialog(
        plan({ red: [{ kind: 'tooLarge', path: 'raw/gel_raw.czi', size: 312 * 1024 * 1024 }], excluded: [{ path: 'raw/gel_raw.czi', reason: 'tooLarge' }] }),
        HEAD,
        { openFile: () => undefined },
      ),
    );
    const upload = screen.getByRole('button', { name: t('github.preview.upload') }) as HTMLButtonElement;
    expect(upload.disabled).toBe(true);
    expect(screen.getAllByText(t('github.preview.mustFix')).length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole('button', { name: t('github.preview.leaveOut') }));
    expect(upload.disabled).toBe(false);
    await userEvent.click(upload);
    const choices = (await p) as UploadChoices;
    expect(choices.untick).toEqual(['raw/gel_raw.czi']);
  });

  it('resolving a finding keeps focus on its button (aria-disabled) and says it is resolved (review)', async () => {
    renderLayer();
    const hit = { kind: 'suspect' as const, path: 'notes.md', line: 14, masked: 'sk-…a9f1', lineHash: 'abc', overridable: true };
    openIn(() => githubPreviewDialog(plan({ red: [{ kind: 'secret', hit }] }), HEAD, { openFile: () => undefined }));
    const leave = screen.getByRole('button', { name: t('github.preview.leaveOut') }) as HTMLButtonElement;
    leave.focus();
    await userEvent.keyboard('{Enter}');
    expect(leave.disabled).toBe(false);
    expect(leave.getAttribute('aria-disabled')).toBe('true');
    expect(document.activeElement).toBe(leave);
    const notKey = screen.getByRole('button', { name: t('github.preview.notAKey') }) as HTMLButtonElement;
    expect(notKey.disabled).toBe(false);
    expect(screen.getByText(t('github.preview.resolved'))).toBeTruthy();
    // pressing it again does nothing (still left out, not toggled back)
    await userEvent.keyboard('{Enter}');
    expect(screen.getByText(t('github.preview.resolved'))).toBeTruthy();
  });

  it('a secret hit can be opened, or marked "not a key" when overridable', async () => {
    renderLayer();
    const opened: string[] = [];
    const hit = { kind: 'suspect' as const, path: 'notes.md', line: 14, masked: 'sk-…a9f1', lineHash: 'abc', overridable: true };
    const p = openIn(() => githubPreviewDialog(plan({ red: [{ kind: 'secret', hit }] }), HEAD, { openFile: (path) => void opened.push(path) }));
    expect(screen.getByText(t('github.preview.secret', 'notes.md', 14, t('github.preview.kind.suspect'), 'sk-…a9f1'))).toBeTruthy();
    expect(screen.getByRole('button', { name: t('github.preview.notAKey') })).toBeTruthy();
    const upload = screen.getByRole('button', { name: t('github.preview.upload') }) as HTMLButtonElement;
    expect(upload.disabled).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: t('github.preview.notAKey') }));
    expect(upload.disabled).toBe(false);
    await userEvent.click(upload);
    await expect(p).resolves.toEqual({ untick: [], allowHits: [{ path: 'notes.md', lineHash: 'abc' }], includeSamples: false });
  });

  it('"open file" closes the preview first, so the file is not opened behind it', async () => {
    renderLayer();
    const opened: Array<{ path: string; dialogOpen: boolean }> = [];
    const hit = { kind: 'suspect' as const, path: 'notes.md', line: 14, masked: 'sk-…a9f1', lineHash: 'abc', overridable: true };
    const p = openIn(() =>
      githubPreviewDialog(plan({ red: [{ kind: 'secret', hit }] }), HEAD, {
        openFile: (path) => void opened.push({ path, dialogOpen: currentDialog() !== null }),
      }),
    );
    await userEvent.click(screen.getByRole('button', { name: t('github.preview.openFile') }));
    await expect(p).resolves.toBe('cancel');
    expect(opened).toEqual([{ path: 'notes.md', dialogOpen: false }]);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('the header says private or public in words, and nothing when visibility is unknown', () => {
    renderLayer();
    void openIn(() => githubPreviewDialog(plan(), HEAD, { openFile: () => undefined }));
    let header = document.querySelector('.github-private')!;
    expect(header.textContent).toContain(t('github.preview.private'));
    expect(header.textContent).toContain(HEAD.fullName);
    cleanupDialogs();

    renderLayer();
    void openIn(() => githubPreviewDialog(plan(), { ...HEAD, private: false }, { openFile: () => undefined }));
    header = document.querySelector('.github-private')!;
    expect(header.textContent).toContain(t('github.preview.public'));
    expect(header.textContent).not.toContain(t('github.preview.private'));
    cleanupDialogs();

    renderLayer();
    void openIn(() => githubPreviewDialog(plan(), { ...HEAD, private: undefined }, { openFile: () => undefined }));
    header = document.querySelector('.github-private')!;
    expect(header.textContent).not.toContain(t('github.preview.private'));
    expect(header.textContent).not.toContain(t('github.preview.public'));
    expect(header.querySelector('svg')).toBeNull();
  });

  it('a private-key hit has no "not a key" button', () => {
    renderLayer();
    const hit = { kind: 'privateKey' as const, path: 'id_rsa.txt', line: 1, masked: '-----BEGIN…', lineHash: 'h', overridable: false };
    void openIn(() => githubPreviewDialog(plan({ red: [{ kind: 'secret', hit }] }), HEAD, { openFile: () => undefined }));
    expect(screen.queryByRole('button', { name: t('github.preview.notAKey') })).toBeNull();
  });

  it('yellow items are listed with file names, including files outside the folder', () => {
    renderLayer();
    void openIn(() =>
      githubPreviewDialog(
        plan({
          yellow: [
            { kind: 'info', info: 'outside', count: 1, paths: ['resources/plasmid_map.png'], names: [] },
            { kind: 'gps', paths: ['images/bench.jpg'] },
            { kind: 'excludedLink', path: 'shortcut.lnk' },
          ],
        }),
        HEAD,
        { openFile: () => undefined },
      ),
    );
    expect(screen.getByText(t('github.preview.outside', 1))).toBeTruthy();
    expect(screen.getByText('resources/plasmid_map.png')).toBeTruthy();
    expect(screen.getByText(t('github.preview.gps', 1))).toBeTruthy();
    expect(screen.getByText(t('github.preview.excludedLink'))).toBeTruthy();
    expect((screen.getByRole('button', { name: t('github.preview.upload') }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('the shared-samples checkbox is off by default and lists each entry', async () => {
    renderLayer();
    const p = openIn(() => githubPreviewDialog(plan({ samples: [{ id: 'DNA-20250527-003', type: 'DNA', name: 'pUC19-GFP' }] }), HEAD, { openFile: () => undefined }));
    const box = screen.getByRole('checkbox', { name: t('github.preview.samples', 1) }) as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(screen.getByText('DNA-20250527-003 (DNA, "pUC19-GFP")')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: t('github.preview.upload') }));
    expect(((await p) as UploadChoices).includeSamples).toBe(false);
  });
});

describe('quick confirm', () => {
  it('names the new and removed files', async () => {
    renderLayer();
    const p = openIn(() =>
      githubQuickDialog(
        plan({
          mode: 'update',
          files: [
            { path: 'images/gel2.png', size: 5, change: 'new' },
            { path: 'old.csv', size: 0, change: 'deleted' },
            { path: 'a.md', size: 1, change: 'same' },
          ],
        }),
      ),
    );
    expect(screen.getByRole('dialog', { name: t('github.quick.title', 1, 1) })).toBeTruthy();
    expect(koText()).toContain('gel2.png');
    expect(koText()).toContain('old.csv');
    expect(koText()).toContain(t('github.quick.historyKept'));
    expect(FORBIDDEN.filter((w) => koText().includes(w))).toEqual([]);
    expect(styleAttributes()).toEqual([]);
    await userEvent.click(screen.getByRole('button', { name: t('github.quick.details') }));
    await expect(p).resolves.toBe('details');
  });
});

describe('changes on GitHub', () => {
  it('"upload my folder version" needs the acknowledgement', async () => {
    renderLayer();
    const p = openIn(() =>
      githubDivergedDialog([
        { path: 'README.labnote.md', change: 'changed', goneHere: false },
        { path: 'notes.txt', change: 'new', goneHere: true },
      ]),
    );
    expect(koText()).toContain(t('github.diverged.goneHere'));
    expect(FORBIDDEN.filter((w) => koText().includes(w))).toEqual([]);
    expect(styleAttributes()).toEqual([]);
    const mine = screen.getByRole('button', { name: t('github.diverged.mine') }) as HTMLButtonElement;
    expect(mine.disabled).toBe(true);
    await userEvent.click(screen.getByRole('checkbox'));
    expect(mine.disabled).toBe(false);
    await userEvent.click(mine);
    await expect(p).resolves.toEqual({ mode: 'mine', ack: ['README.labnote.md', 'notes.txt'] });
  });

  it('the advanced choice keeps the GitHub version', async () => {
    renderLayer();
    const p = openIn(() => githubDivergedDialog([{ path: 'a.md', change: 'changed', goneHere: false }]));
    await userEvent.click(screen.getByRole('button', { name: t('github.settings.advanced') }));
    await userEvent.click(screen.getByRole('button', { name: t('github.diverged.separate') }));
    await expect(p).resolves.toEqual({ mode: 'separate', ack: [] });
  });
});

describe('done', () => {
  it('shows the title and repository with open, invite and close', async () => {
    renderLayer();
    const opened: string[] = [];
    const r = { title: '단백질 발현', fullName: 'parkyaeseong/x', htmlUrl: 'https://github.com/parkyaeseong/x' };
    let done!: Promise<void>;
    act(() => {
      done = showDone(r, (m, c, o) => choiceDialog(m, c, o), (u) => void opened.push(u));
    });
    expect(screen.getByText(t('github.done.title', '단백질 발현', 'parkyaeseong/x'))).toBeTruthy();
    expect(screen.getByRole('button', { name: t('github.menu.open') })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: t('dialog.close') })).toHaveLength(2);
    await userEvent.click(screen.getByRole('button', { name: t('github.done.invite') }));
    await done;
    expect(opened).toEqual(['https://github.com/parkyaeseong/x/settings/access']);
  });
});
