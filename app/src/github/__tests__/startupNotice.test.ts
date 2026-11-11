// @vitest-environment jsdom
import { setLang } from '../../i18n/lang';
import type { FolderStatus } from '../../integrations/githubIpc';
import { githubNoticeOnOpen, onceForThisVault, unfinishedNotice } from '../startupNotice';
import { githubStatusOf, resetGithubStatusesForTest } from '../statusStore';

const S = (over: Partial<FolderStatus>): FolderStatus => ({ linked: true, state: 'pushed', changedCount: 0, folderMissing: false, ...over });

beforeEach(() => {
  setLang('ko');
  resetGithubStatusesForTest();
});

describe('unfinishedNotice', () => {
  it('counts only links that are neither pushed nor planned', () => {
    expect(unfinishedNotice({})).toBeNull();
    expect(unfinishedNotice({ a: S({}), b: S({ state: 'planned' }), c: S({ linked: false, state: 'planned' }) })).toBeNull();
    expect(
      unfinishedNotice({ a: S({}), b: S({ state: 'repoCreating' }), c: S({ state: 'repoReady' }), d: S({ state: 'committed' }) }),
    ).toEqual({ count: 3, folder: 'b' });
  });
});

describe('githubNoticeOnOpen', () => {
  const unfinished = { 'labnote/001_a': S({ state: 'committed' }), 'labnote/002_b': S({ state: 'repoReady' }), 'labnote/003_c': S({}) };

  it('fills the status store and shows one warn toast whose action finishes the first unfinished link', async () => {
    const notify = vi.fn();
    const finish = vi.fn(async () => undefined);
    await githubNoticeOnOpen({ load: async () => unfinished, notify, finish });
    expect(githubStatusOf('labnote/003_c')).toEqual(S({}));
    expect(notify).toHaveBeenCalledTimes(1);
    const [kind, message, opts] = notify.mock.calls[0];
    expect(kind).toBe('warn');
    expect(message).toBe('GitHub 올리기 2건이 끝나지 않았습니다');
    expect(opts.action.label).toBe('마저 하기');
    opts.action.run();
    expect(finish).toHaveBeenCalledWith('labnote/001_a');
  });

  it('says nothing when everything is finished, or when the statuses cannot be read', async () => {
    const notify = vi.fn();
    await githubNoticeOnOpen({ load: async () => ({ a: S({}) }), notify, finish: vi.fn() });
    await githubNoticeOnOpen({
      load: async () => {
        throw new Error('x');
      },
      notify,
      finish: vi.fn(),
    });
    expect(notify).not.toHaveBeenCalled();
  });
});

describe('onceForThisVault', () => {
  it('shows the startup toast once per vault open, however often the screen re-renders', async () => {
    const notify = vi.fn();
    const deps = { load: async () => ({ a: S({ state: 'committed' as const }) }), notify, finish: vi.fn() };
    const open = onceForThisVault(() => githubNoticeOnOpen(deps));
    await open();
    await open();
    expect(notify).toHaveBeenCalledTimes(1);
    // 보관함을 다시 열면(새 화면) 새 가드다
    await onceForThisVault(() => githubNoticeOnOpen(deps))();
    expect(notify).toHaveBeenCalledTimes(2);
  });
});
