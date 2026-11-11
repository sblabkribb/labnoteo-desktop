import { getExperimentDir } from '@labnoteo/core/lib/labnoteStructure';
import { getLang, LANGS, type Lang } from '../../i18n/lang';
import { catalogs, t } from '../../i18n/t';

/**
 * 명령 팔레트의 차림표(2026-11-11 정리). 명령마다 묶음, 묶음 안의 자리, 팔레트 이름, 찾기 별칭, 필요한 맥락을 적는다.
 * - 이름은 `palette.cmd.<id>` 번역 키(ko·en)다. 한 가지 꼴: 한국어는 "<무엇을> <하기>"(실험 만들기, 날짜 넣기),
 *   영어는 동사로 시작하는 문장(Create experiment, Insert date). 앞머리는 AI 동작의 "AI: " 하나만 쓴다.
 *   메뉴·리본·설정의 짧은 이름(nameKey)은 그대로다: 팔레트는 맥락 없이 읽히는 문장이어야 해서 따로 둔다.
 * - 옛 이름(플러그인 이름, 예전 팔레트 이름, 노트 템플릿이 적는 '워크플로 생성' 같은 이름)은 팔레트가 찾기 낱말로 붙인다.
 * - 묶음 안의 차례: `top`(자주 쓰는 것, 적은 차례 그대로), 보통(이름의 가나다·ABC 순), `rare`(드문 것·관리용, 끝에 이름순).
 * - `needs`: 열린 노트가 있어야 하는 명령. 맥락이 없으면 숨기지 않고 흐리게, 이유를 붙여 묶음 끝에 보인다(고르면 이유만 알린다).
 *   설정이나 상태에 따라 생기는 명령(partbank·bfworkflow 연결, 진행 중인 답, GitHub 연결 상태)은 명령의 available 대로 숨는다.
 * 명령 id 는 바꾸지 않는다: 단축키, 리본, 메뉴, 테스트가 id 로 부른다.
 */
export type PaletteGroup = 'note' | 'experiment' | 'sample' | 'ai' | 'services' | 'view' | 'settings';

/** 검색어가 없을 때 묶음의 차례("최근 사용"은 그 위). */
export const PALETTE_GROUPS: readonly PaletteGroup[] = ['note', 'experiment', 'sample', 'ai', 'services', 'view', 'settings'];

const GROUP_KEY: Record<PaletteGroup, string> = {
  note: 'palette.group.note',
  experiment: 'palette.group.experiment',
  sample: 'palette.group.sample',
  ai: 'palette.group.ai',
  services: 'palette.group.services',
  view: 'palette.group.view',
  settings: 'palette.group.settings',
};

export type PaletteNeed = 'note' | 'experiment' | 'workflow';

const NEED_KEY: Record<PaletteNeed, string> = {
  note: 'palette.needs.note',
  experiment: 'palette.needs.experiment',
  workflow: 'palette.needs.workflow',
};

export interface PaletteEntry {
  id: string;
  group: PaletteGroup;
  tier?: 'top' | 'rare';
  needs?: PaletteNeed;
  /** 옛 이름 말고 더 찾을 낱말(예: '빠른 이동'). 보이지 않는다. */
  aliases?: readonly string[];
}

export const PALETTE_ENTRIES: readonly PaletteEntry[] = [
  { id: 'app.newNote', group: 'note', tier: 'top', aliases: ['New note'] },
  { id: 'app.quickSwitcher', group: 'note', tier: 'top', aliases: ['빠른 이동', 'Quick switcher', '노트 열기', 'Quick open'] },
  { id: 'editor-toggle-source', group: 'note', tier: 'top' },
  { id: 'format-bold', group: 'note', tier: 'top', needs: 'note' },
  { id: 'format-italic', group: 'note', tier: 'top', needs: 'note' },
  { id: 'format-link', group: 'note', tier: 'top', needs: 'note' },
  { id: 'format-task', group: 'note', tier: 'top', needs: 'note', aliases: ['체크리스트', 'checklist'] },
  { id: 'editor.insert.table', group: 'note', tier: 'top', needs: 'note' },
  { id: 'insert-date', group: 'note', tier: 'top', needs: 'note' },
  { id: 'insert-datetime', group: 'note', needs: 'note' },
  { id: 'format-strikethrough', group: 'note', needs: 'note' },
  { id: 'format-code', group: 'note', needs: 'note' },
  { id: 'format-highlight', group: 'note', needs: 'note', aliases: ['강조 표시'] },
  { id: 'format-heading-1', group: 'note', needs: 'note' },
  { id: 'format-heading-2', group: 'note', needs: 'note' },
  { id: 'format-heading-3', group: 'note', needs: 'note' },
  { id: 'format-heading-4', group: 'note', needs: 'note' },
  { id: 'format-heading-5', group: 'note', needs: 'note' },
  { id: 'format-heading-6', group: 'note', needs: 'note' },
  { id: 'format-paragraph', group: 'note', needs: 'note' },
  { id: 'format-bullet-list', group: 'note', needs: 'note' },
  { id: 'format-numbered-list', group: 'note', needs: 'note' },
  { id: 'format-quote', group: 'note', needs: 'note' },
  { id: 'format-code-block', group: 'note', needs: 'note' },
  { id: 'editor.insert.codeBlock', group: 'note', needs: 'note' },
  { id: 'editor.insert.callout', group: 'note', needs: 'note' },
  { id: 'editor.insert.hr', group: 'note', needs: 'note' },
  { id: 'editor.insert.mathBlock', group: 'note', needs: 'note' },
  { id: 'props-add', group: 'note', needs: 'note' },
  { id: 'props-edit-yaml', group: 'note', needs: 'note' },
  { id: 'insert-issue-marker', group: 'note', needs: 'note' },
  { id: 'export-tables-csv', group: 'note', needs: 'note' },
  { id: 'show-note-barcode', group: 'note', needs: 'note' },
  { id: 'print-whole-note', group: 'note', tier: 'rare', needs: 'note', aliases: ['출력'] },
  { id: 'assign-note-id', group: 'note', tier: 'rare', needs: 'note' },
  { id: 'links-undo-rename', group: 'note', tier: 'rare' },
  { id: 'create-experiment', group: 'experiment', tier: 'top', aliases: ['새 실험', 'new experiment'] },
  { id: 'create-workflow', group: 'experiment', tier: 'top' },
  { id: 'insert-unit-operation', group: 'experiment', tier: 'top', needs: 'workflow', aliases: ['UO'] },
  { id: 'change-experiment-status', group: 'experiment', tier: 'top' },
  { id: 'app.toggleWorkflowDone', group: 'experiment', tier: 'top', needs: 'workflow' },
  { id: 'sync-workflow-checklist', group: 'experiment' },
  { id: 'retry-experiment', group: 'experiment' },
  { id: 'toggle-discussion-flag', group: 'experiment' },
  { id: 'export-experiment-tables-csv', group: 'experiment' },
  { id: 'update-catalogs', group: 'experiment' },
  { id: 'print-experiment-worksheet', group: 'experiment', needs: 'workflow', aliases: ['출력', 'worksheet'] },
  { id: 'import-scanned-pages', group: 'experiment', aliases: ['스캔'] },
  { id: 'process-scan-folder', group: 'experiment', tier: 'rare' },
  { id: 'assign-unmatched-scans', group: 'experiment', tier: 'rare' },
  { id: 'open-sample-view', group: 'sample', tier: 'top' },
  { id: 'insert-experiment-samples-table', group: 'sample' },
  { id: 'open-sample-definition', group: 'sample' },
  { id: 'assistant.open', group: 'ai', tier: 'top' },
  { id: 'assistant.chat', group: 'ai', tier: 'top' },
  { id: 'ai-ask-agent', group: 'ai', tier: 'top' },
  { id: 'ai-draft-method', group: 'ai' },
  { id: 'ai-summarize-results', group: 'ai' },
  { id: 'ai-summarize-experiment', group: 'ai' },
  { id: 'ai-extract-samples', group: 'ai' },
  { id: 'ai-draft-planning', group: 'ai' },
  { id: 'ai-prefill-input', group: 'ai' },
  { id: 'assistant.createWorkflow', group: 'ai' },
  { id: 'assistant.createUnitOperation', group: 'ai' },
  { id: 'assistant.createSection', group: 'ai' },
  { id: 'assistant.howTo', group: 'ai', aliases: ['도움말', 'help'] },
  { id: 'assistant.stop', group: 'ai' },
  { id: 'assistant.toggleVisible', group: 'ai' },
  { id: 'assistant.clearHistory', group: 'ai', tier: 'rare' },
  { id: 'assistant.resetPosition', group: 'ai', tier: 'rare' },
  { id: 'skins.gallery', group: 'ai', tier: 'rare', aliases: ['스킨 갤러리', 'Skin gallery'] },
  { id: 'skins.editor', group: 'ai', tier: 'rare' },
  { id: 'skins.import', group: 'ai', tier: 'rare' },
  { id: 'skins.export', group: 'ai', tier: 'rare' },
  { id: 'skins.submit', group: 'ai', tier: 'rare' },
  { id: 'download-partbank-catalog', group: 'services', tier: 'top' },
  { id: 'refresh-partbank-locations', group: 'services', tier: 'top' },
  { id: 'app.open-labnoteo-link', group: 'services', tier: 'top' },
  { id: 'app.bfw-notes-from-design', group: 'services', tier: 'top' },
  { id: 'app.bfw-sync-catalogs', group: 'services', tier: 'top' },
  { id: 'app.bfw-open-design', group: 'services', tier: 'top' },
  { id: 'app.bfw-design-usage', group: 'services', tier: 'top', needs: 'workflow' },
  { id: 'toggle-mcp-server', group: 'services', tier: 'top' },
  { id: 'github.uploadExperiment', group: 'services', tier: 'top', needs: 'experiment' },
  { id: 'github.openOnGithub', group: 'services', tier: 'top', needs: 'experiment' },
  { id: 'github.finishUpload', group: 'services', tier: 'top' },
  { id: 'github.disconnect', group: 'services', tier: 'rare' },
  { id: 'app.toggleLeft', group: 'view', tier: 'top' },
  { id: 'app.toggleRight', group: 'view', tier: 'top' },
  { id: 'app.back', group: 'view', tier: 'top' },
  { id: 'app.forward', group: 'view', tier: 'top' },
  { id: 'open-workflow-view', group: 'view' },
  { id: 'outline-show', group: 'view' },
  { id: 'links-show', group: 'view' },
  { id: 'app.revealInTree', group: 'view', needs: 'note' },
  { id: 'app.appearance', group: 'view' },
  { id: 'app.theme.system', group: 'view' },
  { id: 'app.theme.light', group: 'view' },
  { id: 'app.theme.dark', group: 'view' },
  { id: 'app.showSystemFiles', group: 'view', tier: 'rare' },
  { id: 'app.settings', group: 'settings', tier: 'top' },
  { id: 'app.integration-settings', group: 'settings', tier: 'top' },
  { id: 'app.sample-settings', group: 'settings' },
  { id: 'assistant.settings', group: 'settings' },
  { id: 'app.lang.ko', group: 'settings' },
  { id: 'app.lang.en', group: 'settings' },
  { id: 'app.switchVault', group: 'settings' },
  { id: 'app.check-for-updates', group: 'settings' },
  { id: 'app.convert-legacy-notes', group: 'settings', tier: 'rare' },
];

const byId = new Map(PALETTE_ENTRIES.map((e) => [e.id, e]));

export function paletteEntry(id: string): PaletteEntry | undefined {
  return byId.get(id);
}

/** 명령의 팔레트 이름 키. 차림표에 없는 명령은 undefined(팔레트는 명령의 원래 이름을 쓴다). */
export function paletteLabelKey(id: string): string | undefined {
  return byId.has(id) ? ['palette', 'cmd', id].join('.') : undefined; // 'palette.cmd.<id>'
}

/** 팔레트 이름(지금 언어, 또는 `lang`). 차림표에 없으면 undefined. */
export function paletteLabel(id: string, lang: Lang = getLang()): string | undefined {
  const key = paletteLabelKey(id);
  if (key === undefined) return undefined;
  return lang === getLang() ? t(key) : catalogs[lang][key];
}

/** 두 언어의 팔레트 이름(찾기 낱말: 어느 언어로 쳐도 찾는다). */
export function paletteLabels(id: string): string[] {
  return LANGS.map((lang) => paletteLabel(id, lang)).filter((s): s is string => s !== undefined);
}

export function paletteGroupLabel(group: PaletteGroup): string {
  return t(GROUP_KEY[group]);
}

export function paletteNeedReason(need: PaletteNeed): string {
  return t(NEED_KEY[need]);
}

/** 실험 폴더 바로 아래의 `###_….md` 노트(README 아님). 옛 이름(NNN_Wxxx_*.md)도 Workflow 노트로 본다. */
function isWorkflowNote(path: string): boolean {
  const name = path.replace(/\\/g, '/').split('/').pop() ?? '';
  return /^\d{3}_.*\.md$/i.test(name) && !/^readme(\.labnote)?\.md$/i.test(name) && getExperimentDir(path) !== undefined;
}

/** 열린 노트가 `entry` 의 필요를 채우지 못하면 그 필요, 채우거나 필요가 없으면 undefined. */
export function unmetNeed(entry: PaletteEntry | undefined, activePath: string | undefined): PaletteNeed | undefined {
  const need = entry?.needs;
  if (need === undefined) return undefined;
  if (activePath === undefined) return need;
  if (need === 'experiment') return getExperimentDir(activePath) === undefined ? need : undefined;
  if (need === 'workflow') return isWorkflowNote(activePath) ? undefined : need;
  return undefined;
}

/**
 * 용어 규칙의 거꾸로: 'Workflow' 가 든 이름에 '워크플로', 'Unit Operation' 이 든 이름에 '유닛 오퍼레이션'·'단위 공정'·'UO' 를 쓴 이름을 더한다.
 * 플러그인과 예전 노트가 쓴 한국어 낱말로 쳐도 찾게.
 */
export function termVariants(text: string): string[] {
  const out: string[] = [];
  if (/workflow/i.test(text)) out.push(text.replace(/workflow/gi, '워크플로'));
  if (/unit operation/i.test(text)) {
    for (const word of ['유닛 오퍼레이션', '단위 공정', 'UO']) out.push(text.replace(/unit operation/gi, word));
  }
  return out;
}

const TIER_RANK = { top: 0, normal: 1, rare: 2 } as const;

/**
 * 묶음 차례, 그 안에서 top(적은 차례) → 보통(이름순) → rare(이름순). `label` 은 지금 언어의 보이는 이름.
 * 차림표에 없는 명령은 맨 끝(그 밖의 명령)에 이름순으로.
 */
export function comparePalette(a: { id: string; label: string }, b: { id: string; label: string }, lang: Lang = getLang()): number {
  const ea = byId.get(a.id);
  const eb = byId.get(b.id);
  if (!ea || !eb) return ea ? -1 : eb ? 1 : a.label.localeCompare(b.label, lang);
  const g = PALETTE_GROUPS.indexOf(ea.group) - PALETTE_GROUPS.indexOf(eb.group);
  if (g !== 0) return g;
  const ta = TIER_RANK[ea.tier ?? 'normal'];
  const tb = TIER_RANK[eb.tier ?? 'normal'];
  if (ta !== tb) return ta - tb;
  if (ea.tier === 'top') return PALETTE_ENTRIES.indexOf(ea) - PALETTE_ENTRIES.indexOf(eb);
  return a.label.localeCompare(b.label, lang, { numeric: true });
}
