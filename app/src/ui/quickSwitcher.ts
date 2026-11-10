import type { PickItem } from '@labnoteo/core';
import type { CommandContext } from '../labnote/commands/context';
import { ExperimentEntryCache } from '../labnote/panel/experimentEntries';
import { buildExperimentTree, type ExpNode } from '../labnote/panel/experimentTree';
import { fileKind, isNotePath, treeIcon } from '../labnote/panel/treeIcons';
import { linkIndex } from '../links/linkIndex';
import { t } from '../i18n/t';
import type { IconName } from './Icon';

/** 빠른 이동의 결과 하나: 노트, 노트 안의 UO(그 제목 줄로 간다), 첨부(보기로 연다). */
export type SwitcherTarget =
  | { type: 'note'; path: string }
  | { type: 'uo'; path: string; line: number }
  | { type: 'attachment'; path: string };

/** 노트 경로에서 보이는 이름: 마지막 조각에서 .labnote.md / .md 를 뗀다. */
function noteName(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  return base.replace(/\.labnote\.md$/i, '').replace(/\.md$/i, '');
}

const dirOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
const baseOf = (path: string) => path.slice(path.lastIndexOf('/') + 1);

/** 결과의 아이콘: 노트는 종류(실험 README, 워크플로, 노트), UO 는 점, 첨부는 파일 종류. */
export function switcherIcon(target: SwitcherTarget): IconName | undefined {
  if (target.type === 'uo') return 'circle-dot';
  return treeIcon(fileKind(target.path));
}

/**
 * 빠른 이동의 항목(순수): 보이는 파일 목록의 노트와 첨부, 그리고 실험 트리의 UO.
 * - 노트: 이름(.labnote.md 를 뗀), 흐린 폴더. 워크플로 노트는 코드와 별칭으로도 찾는다.
 * - UO: `WB030 pUC19 조립 › UHW100 벡터 증폭`, 흐린 워크플로 노트 경로. 코드·별칭·카탈로그 이름으로 찾는다.
 * - 첨부: 파일 이름(확장자 포함), 흐린 폴더.
 * 노트가 먼저, 그다음 UO, 그다음 첨부(같은 점수면 이 차례).
 */
export function switcherItems(files: readonly string[], tree: readonly ExpNode[]): PickItem<SwitcherTarget>[] {
  const workflows = new Map(tree.flatMap((e) => e.workflows.map((w) => [w.path.toLowerCase(), w] as const)));
  const sorted = [...files].sort((a, b) => a.localeCompare(b));
  const notes: PickItem<SwitcherTarget>[] = [];
  const attachments: PickItem<SwitcherTarget>[] = [];
  for (const path of sorted) {
    const dir = dirOf(path) || undefined;
    if (isNotePath(path)) {
      const wf = workflows.get(path.toLowerCase());
      const extra = wf ? [wf.code, wf.alias, wf.name].filter(Boolean) : [];
      notes.push({ label: noteName(path), description: dir, keywords: [path, ...extra], value: { type: 'note', path } });
    } else {
      attachments.push({ label: baseOf(path), description: dir, keywords: [path], value: { type: 'attachment', path } });
    }
  }
  const uos: PickItem<SwitcherTarget>[] = tree.flatMap((e) =>
    e.workflows.flatMap((w) =>
      w.uos.map((u) => ({
        label: `${w.code} ${w.alias} › ${u.code} ${u.alias}`,
        description: dirOf(w.path) || undefined,
        keywords: [u.code, u.alias, u.name].filter(Boolean),
        value: { type: 'uo', path: w.path, line: u.line } satisfies SwitcherTarget,
      })),
    ),
  );
  return [...notes, ...uos, ...attachments];
}

/** 실험 트리(UO 까지): 워크플로 노트를 읽는다. 읽지 못하면 UO 없이(빈 트리) 간다: 노트와 첨부로는 여전히 간다. */
async function vaultTree(ctx: CommandContext): Promise<ExpNode[]> {
  try {
    const entries = await new ExperimentEntryCache(ctx.host.fs).all();
    return await buildExperimentTree(entries, (p) => ctx.host.fs.read(p));
  } catch {
    return [];
  }
}

/**
 * 빠른 이동(리본의 찾기 단추, Ctrl+O, 명세 §5.5): 노트, UO, 첨부를 이름으로 골라 연다. 팔레트와 같은 꼴이다.
 * UO 를 고르면 그 워크플로 노트를 열고 UO 제목 줄로 간다. 첨부를 고르면 보기(그림, 표, 파일 카드)로 연다.
 */
export async function runQuickSwitcher(ctx: CommandContext, deps: { tree?: () => Promise<readonly ExpNode[]> } = {}): Promise<void> {
  const files = ctx.treeFiles?.() ?? linkIndex.files();
  const tree = await (deps.tree ?? (() => vaultTree(ctx)))();
  const items = switcherItems(files, tree);
  if (items.length === 0) {
    ctx.host.notify('info', t('quickSwitcher.empty'));
    return;
  }
  const chosen = await ctx.host.pick(items, {
    title: t('quickSwitcher.title'),
    placeholder: t('quickSwitcher.placeholder'),
    palette: { iconOf: (item) => switcherIcon(item.value as SwitcherTarget), hint: t('quickSwitcher.hint') },
  });
  if (chosen === undefined) return;
  await ctx.openFile(chosen.path, chosen.type === 'uo' ? { line: chosen.line } : undefined);
}
