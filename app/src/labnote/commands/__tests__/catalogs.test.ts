// @vitest-environment jsdom
import { setLang } from '../../../i18n/lang';
import { createTestHost, type TestHost } from '../../__tests__/testHost';
import { bundledCatalogHash, ensureVaultCatalogs } from '../../port/catalogUpdate';
import { catalogNoticeOnOpen, updateCatalogs } from '../catalogs';

const WORKFLOWS = 'resources/workflows/workflows_en.json';

let h: TestHost;

beforeEach(() => setLang('ko'));

afterEach(() => {
  for (const n of h?.notes ?? []) expect(n.message).toMatch(/[가-힣]/);
  h?.cleanup();
});

/** 카탈로그를 채운 뒤 workflows_en.json 에서 WB155 을 뺀다(번들에 새로 생긴 id 처럼 보인다). */
async function vaultMissingWb155(): Promise<void> {
  await ensureVaultCatalogs(h.host);
  const json = JSON.parse(h.vault.files()[WORKFLOWS]) as { workflows: Array<{ id: string }> };
  json.workflows = json.workflows.filter((w) => w.id !== 'WB155');
  await h.vault.mem.write(WORKFLOWS, JSON.stringify(json, null, 2));
}

describe('update-catalogs', () => {
  it('update-catalogs with nothing pending says up to date', async () => {
    h = createTestHost();
    await updateCatalogs(h.ctx);
    expect(h.vault.files()[WORKFLOWS]).toBeDefined(); // 처음 쓰면 조용히 채운다
    expect(h.asked.confirm).toEqual([]);
    expect(h.notes).toEqual([{ kind: 'info', message: h.host.t('The catalogs are up to date.') }]);
    expect(h.refreshes()).toBe(0);
  });

  it('with an added id asks to confirm and writes', async () => {
    h = createTestHost();
    await vaultMissingWb155();
    h.answer.confirm(true);
    await updateCatalogs(h.ctx);
    expect(h.asked.confirm).toHaveLength(1);
    expect(h.asked.confirm[0].message).toContain('WB155 RCA 기반 표적 증폭');
    expect(h.asked.confirm[0].opts?.confirmLabel).toBe(h.host.t('Update'));
    const ids = (JSON.parse(h.vault.files()[WORKFLOWS]) as { workflows: Array<{ id: string }> }).workflows.map((w) => w.id);
    expect(ids).toContain('WB155');
    expect(h.notes).toEqual([
      {
        kind: 'info',
        message: h.host.t('Updated the catalogs: {0} added, {1} changed. Commit the changed files in {2}.', 1, 0, 'resources/workflows'),
      },
    ]);
    expect(h.refreshes()).toBe(1);
  });

  it('declining writes nothing', async () => {
    h = createTestHost();
    await vaultMissingWb155();
    const before = h.vault.files()[WORKFLOWS];
    h.answer.confirm(false);
    await updateCatalogs(h.ctx);
    expect(h.vault.files()[WORKFLOWS]).toBe(before);
    expect(h.refreshes()).toBe(0);
  });
});

describe('catalogNoticeOnOpen', () => {
  it('catalogNoticeOnOpen notifies once per bundled hash', async () => {
    h = createTestHost();
    await vaultMissingWb155();
    await catalogNoticeOnOpen(h.ctx);
    expect(h.notes).toEqual([
      {
        kind: 'info',
        message: h.host.t('Catalog update available: {0} new, {1} changed. Run "{2}" from the command palette.', 1, 0, h.host.t('Update catalogs')),
      },
    ]);
    expect(h.ctx.settings.catalogNoticeHash).toBe(bundledCatalogHash());
    await catalogNoticeOnOpen(h.ctx);
    expect(h.notes).toHaveLength(1);
  });

  it('a vault without catalog files gets no notice and nothing is written', async () => {
    h = createTestHost();
    await catalogNoticeOnOpen(h.ctx);
    expect(h.notes).toEqual([]);
    expect(Object.keys(h.vault.files())).toEqual([]);
  });

  it('never throws: a failing read leaves the stored hash so it tries again next time', async () => {
    h = createTestHost();
    await vaultMissingWb155();
    h.vault.failNext('vault_exists', 'io');
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(catalogNoticeOnOpen(h.ctx)).resolves.toBeUndefined();
    err.mockRestore();
    expect(h.ctx.settings.catalogNoticeHash).toBe('');
  });
});
