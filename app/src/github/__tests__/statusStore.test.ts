// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { setLang } from '../../i18n/lang';
import type { FolderStatus } from '../../integrations/githubIpc';
import {
  forgetGithubStatus,
  githubStatusOf,
  refreshGithubStatuses,
  resetGithubStatusesForTest,
  setGithubStatuses,
  statusBadge,
  statusKind,
  useGithubStatuses,
} from '../statusStore';

const S = (over: Partial<FolderStatus>): FolderStatus => ({ linked: true, state: 'pushed', changedCount: 0, folderMissing: false, ...over });

beforeEach(() => {
  setLang('ko');
  resetGithubStatusesForTest();
});

describe('statusKind and statusBadge', () => {
  it('maps a status to synced, changed or unfinished; an unlinked folder has none', () => {
    expect(statusKind(undefined)).toBeUndefined();
    expect(statusKind(S({ linked: false, state: 'planned' }))).toBeUndefined();
    expect(statusKind(S({}))).toBe('synced');
    expect(statusKind(S({ changedCount: 3 }))).toBe('changed');
    for (const state of ['repoCreating', 'repoReady', 'committed'] as const) expect(statusKind(S({ state }))).toBe('unfinished');
  });

  it('each badge has its own icon and a text label (colour is never the only signal)', () => {
    expect(statusBadge(S({}))).toEqual({ icon: 'cloud-check', label: 'GitHub에 올라가 있음' });
    expect(statusBadge(S({ changedCount: 2 }))).toEqual({ icon: 'cloud-upload', label: '올리지 않은 변경 2개' });
    expect(statusBadge(S({ state: 'committed' }))).toEqual({ icon: 'cloud-alert', label: '올리기가 끝나지 않았습니다' });
    expect(statusBadge(S({ linked: false, state: 'planned' }))).toBeUndefined();
    setLang('en');
    expect(statusBadge(S({}))?.label).toBe('Uploaded to GitHub');
  });
});

describe('the store', () => {
  it('is filled by githubStatuses and read with a plain getter', async () => {
    const load = vi.fn(async () => ({ 'labnote/001_a': S({}) }));
    await refreshGithubStatuses(load);
    expect(load).toHaveBeenCalledTimes(1);
    expect(githubStatusOf('labnote/001_a')).toEqual(S({}));
    expect(githubStatusOf('labnote/002_b')).toBeUndefined();
  });

  it('a failed load keeps what was there', async () => {
    setGithubStatuses({ 'labnote/001_a': S({}) });
    await refreshGithubStatuses(async () => {
      throw new Error('offline');
    });
    expect(githubStatusOf('labnote/001_a')).toEqual(S({}));
  });

  it('an older answer that arrives late does not overwrite a newer one', async () => {
    let first!: (v: Record<string, FolderStatus>) => void;
    const slow = refreshGithubStatuses(() => new Promise((r) => (first = r)));
    await refreshGithubStatuses(async () => ({ 'labnote/001_a': S({ changedCount: 1 }) }));
    first({ 'labnote/001_a': S({}) });
    await slow;
    expect(githubStatusOf('labnote/001_a')?.changedCount).toBe(1);
  });

  it('subscribers re-render; forgetting a folder removes it', () => {
    const { result } = renderHook(() => useGithubStatuses());
    expect(result.current).toEqual({});
    act(() => setGithubStatuses({ 'labnote/001_a': S({}) }));
    expect(Object.keys(result.current)).toEqual(['labnote/001_a']);
    act(() => forgetGithubStatus('labnote/001_a'));
    expect(result.current).toEqual({});
  });
});
