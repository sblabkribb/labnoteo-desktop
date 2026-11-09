// @vitest-environment jsdom
/**
 * 예전 형식(.md) 실험 노트를 .labnote.md 로 바꾸는 흐름: 제안(보관함을 열 때), 바꾸기(링크를 고치는 이름 바꾸기 길),
 * "다시 묻지 않기", 그리고 팔레트 명령. 가짜 보관함 위의 testHost 로 돈다.
 */
import { setLang } from '../../i18n/lang';
import { t } from '../../i18n/t';
import { linkIndex } from '../../links/linkIndex';
import { convertLegacyNotesCommand, legacyNotesOfferOnOpen } from '../commands/legacyConvert';
import { createTestHost, type TestHost } from './testHost';

const README_MD = [
  '---',
  'title: PCR',
  '---',
  '# PCR',
  '',
  '- [ ] [002_WB010_x](002_WB010_x.md)',
  '',
].join('\n');

function legacyVault(): Record<string, string> {
  return {
    'labnote/002_PCR/README.md': README_MD,
    'labnote/002_PCR/002_WB010_x.md': '# x\n',
    'labnote/002_PCR/plan.md': 'see [link](002_WB010_x.md)\n',
    'labnote/003_Clash/README.md': '# old readme\n',
    'labnote/003_Clash/README.labnote.md': '# new readme\n',
    'notes/other.md': 'wiki [[002_WB010_x]]\n',
  };
}

const hosts: TestHost[] = [];
const host = (...a: Parameters<typeof createTestHost>): TestHost => {
  const h = createTestHost(...a);
  hosts.push(h);
  return h;
};
beforeEach(() => setLang('en'));
afterEach(() => {
  for (const h of hosts.splice(0)) h.cleanup();
  setLang('ko');
});

describe('legacy notes offer on open', () => {
  it('asks once per call with the count, the title and the three choices; Not now renames nothing and changes no setting', async () => {
    const h = host(legacyVault());
    h.answer.choose('later');
    await legacyNotesOfferOnOpen(h.ctx);
    expect(h.asked.choose).toHaveLength(1);
    const asked = h.asked.choose[0];
    expect(asked.opts?.title).toBe(t('legacy.offer.title'));
    expect(asked.message).toBe(t('legacy.offer.body', 2));
    expect(asked.choices.map((c) => c.value)).toEqual(['convert', 'later', 'never']);
    expect(asked.choices.map((c) => c.label)).toEqual([t('legacy.offer.convert'), t('legacy.offer.later'), t('legacy.offer.never')]);
    expect(Object.keys(h.vault.files())).toContain('labnote/002_PCR/README.md');
    expect(h.ctx.settings.legacyNotesOfferDismissed).toBe(false);
    expect(h.vault.log.some((c) => c.cmd === 'vault_rename')).toBe(false);
    // the next open asks again
    await legacyNotesOfferOnOpen(h.ctx);
    expect(h.asked.choose).toHaveLength(2);
  });

  it('a vault with nothing to convert asks nothing', async () => {
    const h = host({ 'labnote/001_A/README.labnote.md': '# a\n', 'notes/x.md': '' });
    await legacyNotesOfferOnOpen(h.ctx);
    expect(h.asked.choose).toEqual([]);
    expect(h.notes).toEqual([]);
  });

  it('Convert renames README.md and 002_WB010_x.md, updates links in other notes, skips and reports the conflict in one notice', async () => {
    const h = host(legacyVault());
    h.answer.choose('convert');
    await legacyNotesOfferOnOpen(h.ctx);
    const files = h.vault.files();
    expect(Object.keys(files).sort()).toEqual(
      [
        'labnote/002_PCR/002_WB010_x.labnote.md',
        'labnote/002_PCR/README.labnote.md',
        'labnote/002_PCR/plan.md',
        'labnote/003_Clash/README.labnote.md',
        'labnote/003_Clash/README.md',
        'notes/other.md',
      ].sort(),
    );
    expect(files['labnote/002_PCR/plan.md']).toBe('see [link](002_WB010_x.labnote.md)\n');
    expect(files['labnote/002_PCR/README.labnote.md']).toContain('- [ ] [002_WB010_x](002_WB010_x.labnote.md)');
    expect(files['labnote/002_PCR/README.labnote.md']).toContain('title: PCR');
    // the wikilink is rewritten by the rename path and resolves to the renamed note
    expect(files['notes/other.md']).toBe('wiki [[002_WB010_x.labnote]]\n');
    expect(linkIndex.resolver().resolveWiki('002_WB010_x', 'notes/other.md')).toBe('labnote/002_PCR/002_WB010_x.labnote.md');
    expect(files['labnote/003_Clash/README.labnote.md']).toBe('# new readme\n');
    // one summary notice: 2 renamed, the conflict named
    expect(h.notes).toHaveLength(1);
    expect(h.notes[0].kind).toBe('warn');
    expect(h.notes[0].message).toContain(t('legacy.done', 2));
    expect(h.notes[0].message).toContain(t('legacy.done.conflicts', 1, 'labnote/003_Clash/README.md'));
    // through the journalled rename path: the last rename is recorded and finished
    expect(h.ctx.links!.journal.current()?.header.status).toBe('done');
    expect(h.refreshes()).toBeGreaterThan(0);
  });

  it('an open note that links to a converted note gets the rewrite in its buffer, saved', async () => {
    const h = host(legacyVault());
    const m = await h.mount('labnote/002_PCR/plan.md');
    h.answer.choose('convert');
    await legacyNotesOfferOnOpen(h.ctx);
    expect(m.view().state.doc.toString()).toBe('see [link](002_WB010_x.labnote.md)\n');
    expect(h.vault.files()['labnote/002_PCR/plan.md']).toBe('see [link](002_WB010_x.labnote.md)\n');
    expect(h.notes).toHaveLength(1);
  });

  it('a rename that fails is collected and reported; the others still run', async () => {
    const h = host(legacyVault());
    h.vault.failNext('vault_rename', 'io');
    h.answer.choose('convert');
    await legacyNotesOfferOnOpen(h.ctx);
    const files = Object.keys(h.vault.files());
    // the first planned rename (002_WB010_x.md) failed, README.md was renamed
    expect(files).toContain('labnote/002_PCR/002_WB010_x.md');
    expect(files).toContain('labnote/002_PCR/README.labnote.md');
    expect(h.notes).toHaveLength(1);
    expect(h.notes[0].message).toContain(t('legacy.done', 1));
    expect(h.notes[0].message).toContain('labnote/002_PCR/002_WB010_x.md');
    expect(h.notes[0].message).toContain(t('legacy.done.failed', 1, `labnote/002_PCR/002_WB010_x.md (${t('links.reason.io')})`));
  });

  it("Don't ask again sets legacyNotesOfferDismissed; later opens ask nothing; the command still works", async () => {
    const h = host(legacyVault());
    h.answer.choose('never');
    await legacyNotesOfferOnOpen(h.ctx);
    expect(h.ctx.settings.legacyNotesOfferDismissed).toBe(true);
    expect(h.vault.log.some((c) => c.cmd === 'vault_rename')).toBe(false);
    await legacyNotesOfferOnOpen(h.ctx);
    expect(h.asked.choose).toHaveLength(1);

    h.answer.choose('convert');
    await convertLegacyNotesCommand(h.ctx);
    expect(h.asked.choose).toHaveLength(2);
    expect(Object.keys(h.vault.files())).toContain('labnote/002_PCR/README.labnote.md');
    expect(Object.keys(h.vault.files())).toContain('labnote/002_PCR/002_WB010_x.labnote.md');
  });

  it('the command says there is nothing to convert when there is none', async () => {
    const h = host({ 'labnote/001_A/README.labnote.md': '# a\n' });
    await convertLegacyNotesCommand(h.ctx);
    expect(h.asked.choose).toEqual([]);
    expect(h.notes).toEqual([{ kind: 'info', message: t('legacy.none') }]);
  });

  it('Korean strings exist for every key', () => {
    setLang('ko');
    for (const key of ['legacy.offer.title', 'legacy.offer.convert', 'legacy.offer.later', 'legacy.offer.never', 'legacy.none', 'cmd.convertLegacyNotes']) {
      expect(t(key)).not.toBe(key);
    }
    expect(t('cmd.convertLegacyNotes')).toBe('예전 형식 노트를 .labnote.md로 바꾸기');
    expect(t('legacy.offer.body', 3)).toContain('3');
  });
});
