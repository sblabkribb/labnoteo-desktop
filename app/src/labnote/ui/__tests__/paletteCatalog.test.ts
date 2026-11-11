import type { PickItem } from '@labnoteo/core';
import { setLang } from '../../../i18n/lang';
import { catalogs } from '../../../i18n/t';
import { appCommands, clearAppCommandsForTest, displayKey, registerAllAppCommands } from '../../../editor/commands/appCommands';
import type { CommandContext } from '../../commands/context';
import { registerAllCommands } from '../../commands/registerAll';
import { clearCommandsForTest, commands } from '../../commands/registry';
import { arrange } from '../../host/Picker';
import { rankPickItems } from '../../port/rankPickItems';
import { openPalette, paletteItems, type PaletteRow } from '../CommandPalette';
import { PALETTE_ENTRIES, PALETTE_GROUPS, paletteEntry, paletteLabelKey } from '../paletteCatalog';

// bfworkflow 명령은 키가 설정됐을 때만 보인다: 이 테스트에서는 설정된 것으로 둔다(찾기 별칭을 보려고).
vi.mock('../../../bfworkflow/bfwApp', async (orig) => ({ ...(await orig<object>()), bfwReady: () => true }));

/** 정리 전(5bf33c4) 팔레트의 모든 명령 id. id 는 바뀌지 않고, 빠진 기능도 없다. */
const IDS_BEFORE = [
  'create-experiment', 'change-experiment-status', 'retry-experiment', 'toggle-discussion-flag', 'create-workflow',
  'sync-workflow-checklist', 'update-catalogs', 'insert-unit-operation', 'insert-date', 'insert-datetime', 'insert-issue-marker',
  'export-tables-csv', 'export-experiment-tables-csv', 'insert-experiment-samples-table', 'open-sample-definition', 'open-sample-view',
  'download-partbank-catalog', 'refresh-partbank-locations', 'open-workflow-view', 'ai-draft-method', 'ai-summarize-results',
  'ai-summarize-experiment', 'ai-extract-samples', 'ai-ask-agent', 'show-note-barcode', 'assign-note-id', 'print-experiment-worksheet',
  'print-whole-note', 'import-scanned-pages', 'process-scan-folder', 'assign-unmatched-scans', 'toggle-mcp-server',
  'editor-toggle-source', 'outline-show', 'links-show', 'app.back', 'app.forward', 'links-undo-rename', 'format-bold', 'format-italic',
  'format-strikethrough', 'format-code', 'format-highlight', 'format-link', 'format-heading-1', 'format-heading-2', 'format-heading-3',
  'format-heading-4', 'format-heading-5', 'format-heading-6', 'format-paragraph', 'format-bullet-list', 'format-numbered-list',
  'format-task', 'format-quote', 'format-code-block', 'props-add', 'props-edit-yaml', 'app.sample-settings', 'app.convert-legacy-notes',
  'app.toggleWorkflowDone', 'app.integration-settings', 'app.bfw-sync-catalogs', 'app.bfw-notes-from-design', 'app.bfw-open-design',
  'app.bfw-design-usage', 'app.open-labnoteo-link', 'app.check-for-updates', 'app.toggleLeft', 'app.toggleRight', 'app.newNote',
  'app.quickSwitcher', 'app.settings', 'app.appearance', 'app.switchVault', 'app.showSystemFiles', 'app.revealInTree',
  'editor.insert.table', 'editor.insert.callout', 'editor.insert.codeBlock', 'editor.insert.hr', 'editor.insert.mathBlock',
  'app.theme.system', 'app.theme.light', 'app.theme.dark', 'app.lang.ko', 'app.lang.en', 'ai-draft-planning', 'ai-prefill-input',
  'assistant.open', 'assistant.toggleVisible', 'assistant.resetPosition', 'assistant.settings', 'assistant.chat', 'assistant.stop',
  'assistant.clearHistory', 'assistant.howTo', 'assistant.createSection', 'assistant.createUnitOperation', 'assistant.createWorkflow',
  'skins.import', 'skins.export', 'skins.editor', 'skins.gallery', 'skins.submit', 'github.uploadExperiment', 'github.openOnGithub',
  'github.finishUpload', 'github.disconnect',
];

const README = 'labnote/001_PCR/README.md';
const LEGACY_WF = 'labnote/001_PCR/001_W010_PCR.md';

function makeCtx(activePath?: string, host: Partial<CommandContext['host']> = {}): CommandContext {
  return {
    host: { notify: vi.fn(), ...host } as unknown as CommandContext['host'],
    vaultRoot: 'C:/vault',
    settings: {} as CommandContext['settings'],
    updateSettings: () => undefined,
    activePath: () => activePath,
    activeView: () => undefined,
    openFile: async () => undefined,
    closeActive: async () => true,
    refresh: () => undefined,
    showPanel: () => undefined,
  };
}

const row = (item: PickItem<unknown>) => item.value as PaletteRow;
const idOf = (item: PickItem<unknown>) => row(item).command.id;
const byId = (items: PickItem<PaletteRow>[], id: string) => items.find((i) => idOf(i) === id);
/** 검색어가 없을 때 보이는 묶음 머리(차례대로). */
function heads(items: PickItem<PaletteRow>[], recent: string[] = []) {
  const arranged = arrange(items, '', recent, (i) => row(i).group, idOf, '그 밖의 명령', '최근 사용');
  return { ...arranged, names: [...arranged.heads.entries()].sort((a, b) => a[0] - b[0]).map(([, h]) => h) };
}
const top = (items: PickItem<PaletteRow>[], q: string) => {
  const first = rankPickItems(items, q)[0];
  return first ? idOf(first) : undefined;
};

beforeEach(() => {
  registerAllCommands();
  registerAllAppCommands();
});
afterEach(() => {
  clearCommandsForTest();
  clearAppCommandsForTest();
  setLang('ko');
});

describe('팔레트 차림표', () => {
  it('every palette command has exactly one entry, ids are the ones before the reorganisation, and none was removed', () => {
    const registered = [...commands().map((c) => c.id), ...appCommands().filter((c) => c.inPalette !== false).map((c) => c.id)];
    const catalogued = PALETTE_ENTRIES.map((e) => e.id);
    expect(new Set(catalogued).size).toBe(catalogued.length);
    expect([...registered].sort()).toEqual([...IDS_BEFORE].sort());
    expect([...catalogued].sort()).toEqual([...IDS_BEFORE].sort());
  });

  it('every entry has a palette name in ko and en; group and reason keys exist', () => {
    const missing = PALETTE_ENTRIES.flatMap((e) => {
      const key = paletteLabelKey(e.id)!;
      return (['ko', 'en'] as const).filter((l) => !catalogs[l][key]).map((l) => `${l} ${key}`);
    });
    const extra = ['recent', 'other', 'needs.note', 'needs.experiment', 'needs.workflow', ...PALETTE_GROUPS.map((g) => `group.${g}`)]
      .map((k) => `palette.${k}`)
      .flatMap((k) => (['ko', 'en'] as const).filter((l) => !catalogs[l][k]).map((l) => `${l} ${k}`));
    expect([...missing, ...extra]).toEqual([]);
  });
});

describe('빈 검색어의 묶음', () => {
  it('shows purpose groups in the fixed order with headings, recently used on top', () => {
    const items = paletteItems(makeCtx(README));
    expect(heads(items).names).toEqual(['노트·편집', '실험·Workflow·Unit Operation', '샘플', 'AI·어시스턴트', '연결 서비스', '보기·창', '설정·도움말']);
    const withRecent = heads(items, ['create-workflow']);
    expect(withRecent.names[0]).toBe('최근 사용');
    expect(idOf(withRecent.items[0])).toBe('create-workflow');
  });

  it('groups are contiguous, in PALETTE_GROUPS order; in each group the frequent ones come first in their listed order, then by name, rare last', () => {
    const items = paletteItems(makeCtx(LEGACY_WF));
    const entries = items.map((i) => paletteEntry(idOf(i))!);
    const groupOrder = entries.map((e) => PALETTE_GROUPS.indexOf(e.group));
    expect(groupOrder).toEqual([...groupOrder].sort((a, b) => a - b));
    for (const g of PALETTE_GROUPS) {
      const rows = items.filter((i) => paletteEntry(idOf(i))!.group === g && !i.dimmed);
      const tier = (i: PickItem<PaletteRow>) => ({ top: 0, normal: 1, rare: 2 })[paletteEntry(idOf(i))!.tier ?? 'normal'];
      const tiers = rows.map(tier);
      expect(tiers, g).toEqual([...tiers].sort((a, b) => a - b));
      const tops = rows.filter((i) => tier(i) === 0).map(idOf);
      expect(tops, g).toEqual(PALETTE_ENTRIES.filter((e) => e.group === g && e.tier === 'top' && tops.includes(e.id)).map((e) => e.id));
      for (const t of [1, 2]) {
        const labels = rows.filter((i) => tier(i) === t).map((i) => i.label);
        expect(labels, `${g} ${t}`).toEqual([...labels].sort((a, b) => a.localeCompare(b, 'ko', { numeric: true })));
      }
    }
    expect(items.slice(0, 4).map((i) => i.label)).toEqual(['새 노트 만들기', '노트·UO·첨부 빠르게 열기', '소스 보기 켜기/끄기', '굵게 하기']);
  });
});

describe('이름', () => {
  const VERBS = new Set(
    ('Add Assign Browse Change Chat Check Clear Convert Create Disconnect Download Draft Edit Export Extract Finish Go Import Insert ' +
      'Make Open Prefill Print Process Refresh Reset Retry Reveal Show Stop Submit Summarize Switch Sync Toggle Turn Undo Update Upload Use Wrap Ask')
      .split(' '),
  );
  const names = (lang: 'ko' | 'en') => PALETTE_ENTRIES.map((e) => catalogs[lang][paletteLabelKey(e.id)!]);

  it('ko: one pattern "<무엇을> <하기>", no prefix except "AI: ", the English terms Workflow / Unit Operation', () => {
    const ko = names('ko');
    expect(ko.filter((n) => !/기(…| \([^)]*\))?$/.test(n))).toEqual([]);
    expect(ko.filter((n) => n.includes(':') && !n.startsWith('AI: '))).toEqual([]);
    expect(ko.filter((n) => /워크플로|유닛 ?오퍼레이션|단위 ?공정/.test(n))).toEqual([]);
    expect(ko.filter((n) => /^(partbank|bfworkflow|넣기|테마|언어|모양|빠른 이동):/.test(n))).toEqual([]);
  });

  it('en: every name starts with a verb (after "AI: "), no other prefix, no Hangul', () => {
    const en = names('en');
    expect(en.filter((n) => !VERBS.has(n.replace(/^AI: /, '').split(' ')[0]))).toEqual([]);
    expect(en.filter((n) => n.includes(':') && !n.startsWith('AI: '))).toEqual([]);
    expect(en.filter((n) => /[가-힣]/.test(n))).toEqual([]);
  });

  it('no two commands share a name in either language (no duplicates in the list)', () => {
    for (const lang of ['ko', 'en'] as const) {
      const list = names(lang);
      expect(list.filter((n, i) => list.indexOf(n) !== i), lang).toEqual([]);
    }
    const items = paletteItems(makeCtx(LEGACY_WF));
    const ids = items.map(idOf);
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
  });
});

describe('찾기', () => {
  it('old names, plugin names written into notes, both languages and the Workflow / Unit Operation terms still find the command', () => {
    const items = paletteItems(makeCtx(LEGACY_WF));
    const cases: Array<[string, string]> = [
      ['워크플로 생성', 'create-workflow'],
      ['Workflow 생성', 'create-workflow'],
      ['Create workflow', 'create-workflow'],
      ['워크플로 만들기', 'create-workflow'],
      ['실험 생성', 'create-experiment'],
      ['Create experiment', 'create-experiment'],
      ['Unit Operation 삽입', 'insert-unit-operation'],
      ['유닛 오퍼레이션 삽입', 'insert-unit-operation'],
      ['Insert unit operation', 'insert-unit-operation'],
      ['넣기: 표', 'editor.insert.table'],
      ['Insert: table', 'editor.insert.table'],
      ['Workflow 뷰 열기', 'open-workflow-view'],
      ['워크플로 뷰 열기', 'open-workflow-view'],
      ['빠른 이동', 'app.quickSwitcher'],
      ['테마: 어둡게', 'app.theme.dark'],
      ['bfworkflow: 카탈로그 동기화', 'app.bfw-sync-catalogs'],
      ['bfworkflow: Sync catalogs', 'app.bfw-sync-catalogs'],
      ['연동 설정', 'app.integration-settings'],
      ['샘플 뷰 열기', 'open-sample-view'],
      ['굵게', 'format-bold'],
      ['Bold', 'format-bold'],
      ['Ctrl+B', 'format-bold'],
      ['format-bold', 'format-bold'],
    ];
    expect(cases.map(([q]) => [q, top(items, q)])).toEqual(cases);
    setLang('en');
    const en = paletteItems(makeCtx(LEGACY_WF));
    expect(byId(en, 'create-workflow')!.label).toBe('Create Workflow');
    expect([top(en, '실험 만들기'), top(en, '워크플로 생성'), top(en, 'Workflow 생성')]).toEqual(['create-experiment', 'create-workflow', 'create-workflow']);
  });
});

describe('단축키와 맥락', () => {
  it('every command with a shortcut shows it', () => {
    const items = paletteItems(makeCtx(LEGACY_WF));
    const keyed = [
      ...commands().filter((c) => c.shortcut).map((c) => [c.id, displayKey(c.shortcut!)]),
      ...appCommands().filter((c) => c.key && c.inPalette !== false).map((c) => [c.id, displayKey(c.key!)]),
    ];
    expect(keyed.length).toBeGreaterThan(25);
    expect(keyed.map(([id]) => [id, row(byId(items, id!)!).kbd])).toEqual(keyed);
    expect(['app.newNote', 'app.settings', 'assistant.open', 'format-bold'].map((id) => row(byId(items, id)!).kbd)).toEqual(['Ctrl+N', 'Ctrl+,', 'Ctrl+Shift+Y', 'Ctrl+B']);
  });

  it('commands that need an open note are shown dimmed with the reason, at the end of their group', () => {
    const none = paletteItems(makeCtx());
    const bold = byId(none, 'format-bold')!;
    expect([bold.dimmed, bold.description]).toEqual([true, '노트를 열면 쓸 수 있습니다']);
    expect(byId(none, 'github.uploadExperiment')!.description).toBe('실험의 노트를 열면 쓸 수 있습니다');
    expect(byId(none, 'insert-unit-operation')!.description).toBe('Workflow 노트를 열면 쓸 수 있습니다');
    const note = none.filter((i) => row(i).group === '노트·편집');
    const firstDim = note.findIndex((i) => i.dimmed);
    expect(note.slice(firstDim).every((i) => i.dimmed)).toBe(true);
    expect(note.slice(0, firstDim).map(idOf)).toEqual(expect.arrayContaining(['app.newNote', 'app.quickSwitcher']));

    // README(옛 이름)는 노트와 실험을 채우지만 Workflow 노트는 아니다; 옛 이름의 Workflow 노트(NNN_Wxxx_*.md)는 채운다
    const readme = paletteItems(makeCtx(README));
    expect([byId(readme, 'format-bold')!.dimmed, byId(readme, 'github.uploadExperiment')!.dimmed]).toEqual([undefined, undefined]);
    expect(byId(readme, 'insert-unit-operation')!.dimmed).toBe(true);
    expect(byId(paletteItems(makeCtx(LEGACY_WF)), 'insert-unit-operation')!.dimmed).toBeUndefined();
  });

  it('choosing a dimmed row says why and does not run the command', async () => {
    const run = vi.fn(async () => undefined);
    const notify = vi.fn();
    const ctx = makeCtx(undefined, {
      notify,
      pick: (async (items: readonly PickItem<PaletteRow>[]) => {
        const r = byId([...items], 'insert-date')!.value;
        r.command = { ...r.command, run };
        return r;
      }) as unknown as CommandContext['host']['pick'],
    });
    await openPalette(ctx);
    expect(run).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith('info', '노트를 열면 쓸 수 있습니다');
  });
});
