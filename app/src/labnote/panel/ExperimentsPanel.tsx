import { Fragment, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { TreeNode, UnitOperationItem, WorkflowItem } from '@labnoteo/core';
import { buildWorkflowTree } from '@labnoteo/core';
import * as posix from '@labnoteo/core/posix';
import { loadUnitOperations, loadWorkflows } from '@labnoteo/core/lib/workflowDataLoader';
import { t } from '../../i18n/t';
import { useLang } from '../../i18n/useLang';
import { editorStatus, subscribeEditorStatus, useEditorText } from '../../editor/editorStatus';
import { Icon } from '../../ui/Icon';
import { SelectMenu } from '../../ui/SelectMenu';
import { vaultRefresh, type CommandContext } from '../commands/context';
import { changeExperimentStatus, createExperiment, retryExperiment, toggleDiscussionFlag } from '../commands/experiment';
import { commandById } from '../commands/registry';
import { runCommand } from '../commands/runCommand';
import { insertUnitOp } from '../commands/unitOp';
import { createWorkflow, toggleWorkflowTick } from '../commands/workflow';
import { coreLocale, coreT } from '../i18n';
import { samePath, VAULT_ROOT } from '../paths';
import { catalogDescription } from '../port/aliasHints';
import { CATALOG_DIR, ensureVaultCatalogs } from '../port/catalogUpdate';
import { statusNames } from '../port/status';
import { discussWords, showMarkers, treeLabels } from '../port/workflowView';
import { statusLabel, statusShape } from '../statusLabels';
import { openMenu, type MenuAnchor, type MenuItem } from '../ui/menuStore';
import { ExperimentEntryCache, type PanelEntry } from './experimentEntries';
import { publishExperimentTree } from './experimentTreeSnapshot';
import {
  coreEntryMatcher,
  experimentLabel,
  experimentNodes,
  filterTree,
  groupByFromSetting,
  groupExperiments,
  settingFromGroupBy,
  uoDone,
  WorkflowNodeCache,
  workflowState,
  type ExpNode,
  type GroupBy,
  type Range,
  type UoNode,
  type WfNode,
} from './experimentTree';
import { TreeView, type TreeAction, type TreeBadge, type TreeState } from './TreeView';
import { githubMenuItems } from '../../github/commands';
import { statusBadge, useGithubStatuses } from '../../github/statusStore';
import { CatalogPopover, type CatalogEntry, type CatalogTarget } from './CatalogPopover';
import { touchesDir, useVaultChanges } from './useVaultChanges';

export interface ExperimentsPanelProps {
  ctx: CommandContext;
  /** 편집기에 열린 노트: 그 노트의 갈래를 펼치고 보이게 한다. */
  activePath?: string;
  /** 본문이 첨부 보기(그림, 표, 파일 카드)라 열린 노트가 가려져 있다: 그 노트와 커서 UO 를 강조하지 않는다. */
  noteHidden?: boolean;
}

interface Catalog {
  workflows: WorkflowItem[];
  hwUnitOps: UnitOperationItem[];
  swUnitOps: UnitOperationItem[];
}

/** 트리 줄 하나가 무엇인가(TreeNode.id -> 이것). */
type Item =
  | { kind: 'group' }
  | { kind: 'experiment'; exp: ExpNode }
  | { kind: 'workflow'; exp: ExpNode; wf: WfNode }
  | { kind: 'uo'; wf: WfNode; uo: UoNode }
  | { kind: 'readme'; exp: ExpNode }
  | { kind: 'folder'; exp: ExpNode; name: string; count: number }
  | { kind: 'addWorkflow'; exp: ExpNode }
  | { kind: 'addUo'; wf: WfNode };

const GROUPS: readonly GroupBy[] = ['status', 'experimenter', 'project', 'updated', 'discuss'];

const SHAPE_ICON = { dashed: 'circle-dashed', half: 'circle-half', check: 'circle-check' } as const;
const WF_ICON = { ticked: 'circle-check', tickedOpen: 'circle-half', partial: 'circle-half', none: 'circle-dashed' } as const;

/** 카탈로그를 보관함에 채우고(없는 것만) 읽는다. 루트는 늘 VAULT_ROOT('.')다. */
async function loadCatalog(ctx: CommandContext): Promise<Catalog> {
  await ensureVaultCatalogs(ctx.host);
  const [catalog, hw, sw] = await Promise.all([
    loadWorkflows(ctx.host.fs, VAULT_ROOT),
    loadUnitOperations(ctx.host.fs, VAULT_ROOT, 'hw'),
    loadUnitOperations(ctx.host.fs, VAULT_ROOT, 'sw'),
  ]);
  return { workflows: catalog.workflows, hwUnitOps: hw.unitOperations, swUnitOps: sw.unitOperations };
}

/** 카탈로그 줄이 가리키는 항목(뿌리·분류 줄이면 undefined). */
function catalogEntry(node: TreeNode): CatalogEntry | undefined {
  if (node.kind === 'workflow') return { kind: 'workflow', item: node.payload as WorkflowItem };
  if (node.kind === 'unitOperation') {
    const { opType, ...item } = node.payload as UnitOperationItem & { opType: 'hw' | 'sw' };
    return { kind: 'uo', item, opType };
  }
  return undefined;
}

/** 코어 카탈로그 트리의 이름을 고친다: 뿌리는 지역화(워크플로 / HW UO / SW UO), 개수는 덧말로, 항목은 영어 이름만(코드는 오른쪽). */
function relabelCatalog(nodes: readonly TreeNode[]): TreeNode[] {
  const strip = (label: string) => label.replace(/\s*\[\d+\]$/, '');
  const walk = (node: TreeNode): TreeNode => {
    const children = node.children?.map(walk);
    if (node.kind === 'workflowRoot') return { ...node, label: t('catalog.workflows'), children };
    if (node.kind === 'unitOpRoot') {
      const hw = (node.payload as { opType?: string } | undefined)?.opType === 'hw';
      return { ...node, label: hw ? t('catalog.hw') : t('catalog.sw'), children };
    }
    if (node.kind === 'category') return { ...node, label: strip(node.label), children };
    if (node.kind === 'workflow' || node.kind === 'unitOperation') {
      const item = node.payload as { id: string; name: string };
      return { ...node, label: item.name, children };
    }
    return { ...node, children };
  };
  return nodes.map(walk);
}

/** 카탈로그 줄의 오른쪽 코드. */
const catalogCode = (node: TreeNode): string | undefined =>
  node.kind === 'workflow' || node.kind === 'unitOperation' ? (node.payload as { id: string }).id : undefined;

/** 카탈로그 뿌리·분류 줄의 개수. */
const catalogMeta = (node: TreeNode): string | undefined => (node.children && node.children.length > 0 ? String(node.children.length) : undefined);

/** 글에서 맞은 자리를 <mark> 로 감싼다. */
function marked(text: string, ranges: readonly Range[] | undefined): ReactNode {
  if (!ranges || ranges.length === 0) return text;
  const out: ReactNode[] = [];
  let at = 0;
  ranges.forEach(([from, to], i) => {
    if (from > at) out.push(<Fragment key={`t${i}`}>{text.slice(at, from)}</Fragment>);
    out.push(<mark key={`m${i}`}>{text.slice(from, to)}</mark>);
    at = to;
  });
  if (at < text.length) out.push(<Fragment key="end">{text.slice(at)}</Fragment>);
  return out;
}

/** 열린 노트의 커서 줄(1부터). 다른 노트의 상태면 undefined. 줄이 바뀔 때만 다시 그린다. */
function useCursorLine(path: string | undefined): number | undefined {
  const get = () => {
    const s = editorStatus();
    return s && s.path === path ? s.line : undefined;
  };
  return useSyncExternalStore(subscribeEditorStatus, get, get);
}

/**
 * 실험 탭(플러그인 views/workflowView.ts 의 앱판, UI 재설계 Task 10): 실험 → 워크플로 → UO 세 단계 트리.
 * - 상태별 묶음(진행 중 · 계획 · 완료)이 기본이고, 묶는 기준은 설정 workflowViewGroupBy(플러그인 값)에 남는다.
 * - 실험을 펼치면 워크플로(파일 번호 차례), README, images/·resources/(개수), "+ 워크플로 추가" 줄. 워크플로를 펼치면
 *   UO 와 "+ 유닛 오퍼레이션 추가" 줄. 추가 줄과 줄 위의 `+` 는 열린 노트가 아니라 **그 줄의** 실험·워크플로에 더한다.
 * - 워크플로의 상태 아이콘을 누르면 README 체크리스트의 그 항목을 체크하거나 푼다.
 * - 찾기는 세 단계를 다 본다(experimentTree.filterTree). 맞은 것의 조상은 펼치고 맞은 글자를 칠한다.
 * - 열린 노트의 갈래는 펼치고 보이게 스크롤한다. 커서가 든 UO 는 강조색이다.
 * - 첫 그리기는 README 와 폴더 목록만 읽고, 워크플로 본문(UO)과 `@issue` 마커 수는 뒤에서 채운다. 보관함 변경과
 *   vaultRefresh 에 바뀐 것만 버리고 다시 읽는다. 새 줄이 올 때까지 옛 줄을 둔다.
 */
export function ExperimentsPanel({ ctx, activePath, noteHidden = false }: ExperimentsPanelProps) {
  const lang = useLang();
  // GitHub 상태 표시와 메뉴: 상태가 바뀌면 다시 그린다.
  const githubStatuses = useGithubStatuses();
  const { host } = ctx;
  const cache = useMemo(() => new ExperimentEntryCache(host.fs), [host]);
  const [entries, setEntries] = useState<PanelEntry[]>();
  /** 워크플로 경로 -> 본문(UO 제목). 바뀐 경로만 버린다. */
  const texts = useRef(new Map<string, string>());
  const [textsVersion, setTextsVersion] = useState(0);
  /** 워크플로 노드: 본문이 같으면 다시 읽지 않는다(열린 노트를 고칠 때마다 보관함 전체를 다시 읽지 않게). */
  const wfCache = useMemo(() => new WorkflowNodeCache(), []);
  const [catalog, setCatalog] = useState<Catalog>();
  const [query, setQuery] = useState('');
  /** 카탈로그 구역: 처음엔 접혀 있다. */
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [popover, setPopover] = useState<{ entry: CatalogEntry; anchor: HTMLElement }>();
  const [groupBy, setGroupBy] = useState<GroupBy>(groupByFromSetting(ctx.settings.workflowViewGroupBy));
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  /** 이 패널에서 바꾼 실험: 찾기에 더는 맞지 않아도 남긴다(다시 우클릭해 되돌릴 수 있게, 플러그인 #356). */
  const kept = useRef(new Set<string>());
  /** 한 번 펼친 묶음: 다시 그려도 사람이 접은 묶음을 다시 펼치지 않는다. */
  const seeded = useRef(new Set<string>());
  /** 마지막으로 갈래를 펼쳐 준 열린 노트. */
  const revealed = useRef<string>();
  const live = useRef(true);
  const generation = useRef(0);
  const cancelCount = useRef<() => void>();

  const readTexts = useCallback(
    (list: readonly PanelEntry[], gen: number) => {
      const missing = list.flatMap((e) => e.workflowFiles.map((w) => w.path)).filter((p) => !texts.current.has(p));
      if (missing.length === 0) return;
      void Promise.all(
        missing.map(async (p) => {
          try {
            texts.current.set(p, await host.fs.read(p));
          } catch {
            // 읽지 못한 노트: 파일 이름만으로 그린다
          }
        }),
      ).then(() => {
        if (live.current && gen === generation.current) setTextsVersion((v) => v + 1);
      });
    },
    [host],
  );

  const reload = useCallback(() => {
    const gen = ++generation.current;
    cancelCount.current?.();
    void cache
      .all()
      .then((next) => {
        if (!live.current || gen !== generation.current) return;
        setEntries(next);
        readTexts(next, gen);
        cancelCount.current = cache.countMarkers((folder, n) => {
          if (!live.current || gen !== generation.current) return;
          setEntries((prev) => prev?.map((e) => (e.folder === folder ? { ...e, markers: n } : e)));
        });
      })
      .catch((err) => console.error('[labnoteo] reading experiments failed:', err));
  }, [cache, readTexts]);

  const forget = useCallback((paths: readonly string[] | 'all') => {
    cache.invalidate(paths);
    if (paths === 'all') texts.current.clear();
    else {
      const changed = paths.map((p) => p.toLowerCase());
      for (const key of [...texts.current.keys()]) {
        const k = key.toLowerCase();
        if (changed.some((p) => p === k || k.startsWith(`${p}/`))) texts.current.delete(key);
      }
    }
  }, [cache]);

  const reloadCatalog = useCallback(() => {
    void loadCatalog(ctx)
      .then((c) => live.current && setCatalog(c))
      .catch((err) => console.error('[labnoteo] reading the catalog failed:', err));
  }, [ctx]);

  useEffect(() => {
    live.current = true;
    reload();
    reloadCatalog();
    const unsubscribe = vaultRefresh.subscribe(() => {
      forget('all');
      reload();
      reloadCatalog();
    });
    return () => {
      live.current = false;
      cancelCount.current?.();
      unsubscribe();
    };
  }, [forget, reload, reloadCatalog]);

  useVaultChanges((paths) => {
    forget(paths);
    reload();
    if (paths === 'all' || touchesDir(paths, CATALOG_DIR)) reloadCatalog();
  });

  // 열린 워크플로 노트는 편집기의 본문으로 그린다(저장 전 UO 도 보인다)
  const liveText = useEditorText(activePath);
  const cursorLine = useCursorLine(activePath);
  const nodes = useMemo(() => {
    const all = entries ?? [];
    const map = new Map(texts.current);
    if (activePath && liveText) {
      const key = [...map.keys()].find((k) => samePath(k, activePath));
      if (key !== undefined) map.set(key, liveText);
    }
    wfCache.keepOnly(all.flatMap((e) => e.workflowFiles.map((w) => w.path)));
    return experimentNodes(all, map, wfCache);
    // textsVersion: 뒤에서 읽은 본문이 들어왔다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, textsVersion, activePath, liveText, wfCache]);

  // 빠른 이동이 다시 읽지 않고 쓰게 다 읽은 트리를 내놓는다(UO 본문이 아직 오는 중이면 내놓지 않는다). 패널이 닫히면 거둔다.
  const complete = entries !== undefined && entries.every((e) => e.workflowFiles.every((w) => texts.current.has(w.path)));
  useEffect(() => {
    publishExperimentTree(complete ? nodes : undefined);
  }, [nodes, complete]);
  useEffect(() => () => publishExperimentTree(undefined), []);

  // 찾기는 플러그인처럼 날짜(`2026-11`), 논의 낱말, 폴더·노트 이름도 본다(코어 filterExperiments)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const matcher = useMemo(() => coreEntryMatcher(discussWords(host), statusNames(host)), [host, lang]);
  // 커서 줄만 바뀌면 다시 찾거나 묶지 않는다
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const found = useMemo(() => filterTree(nodes, query, undefined, matcher), [nodes, query, matcher, lang]);
  const fullWorkflows = useMemo(() => new Map(nodes.flatMap((n) => n.workflows).map((w) => [w.id, w])), [nodes]);
  const searching = query.trim() !== '';
  const groups = useMemo(() => {
    const shownNodes = searching ? [...found.nodes, ...nodes.filter((n) => kept.current.has(n.dir) && !found.nodes.some((f) => f.id === n.id))] : found.nodes;
    const labels = {
      ...treeLabels(host),
      project: t('experiments.project'),
      noProject: t('experiments.noProject'),
      author: t('experiments.experimenter'),
      noAuthor: t('experiments.noExperimenter'),
      noStatus: t('experiments.noStatus'),
    };
    return groupExperiments(shownNodes, groupBy, labels);
    // lang: 묶음 이름이 지역화된다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [found, nodes, searching, groupBy, host, lang]);

  // 줄 모델: TreeNode 와 그 줄이 무엇인지(items)
  const items = new Map<string, Item>();
  const put = (node: TreeNode, item: Item): TreeNode => {
    items.set(node.id, item);
    return node;
  };
  const tipOf = (exp: ExpNode) =>
    [
      experimentLabel(exp),
      exp.dir,
      `${coreT('Status')}: ${exp.status ? statusLabel(exp.status) : t('experiments.noStatus')}`,
      ...(exp.project ? [`${t('experiments.project')}: ${exp.project}`] : []),
      ...(exp.experimenter ? [`${t('experiments.experimenter')}: ${exp.experimenter}`] : []),
      ...(exp.entry.lastUpdated ? [`${coreT('Last updated')}: ${exp.entry.lastUpdated}`] : []),
      ...(exp.entry.discuss ? [coreT('Flagged for discussion')] : []),
      ...(exp.entry.markers ? [`${coreT('@issue markers')}: ${exp.entry.markers}`] : []),
    ].join('\n');

  const workflowTree = (exp: ExpNode, wf: WfNode): TreeNode => {
    const partial = found.partial.has(wf.id);
    const children = [
      ...wf.uos.map((uo) =>
        put({ id: uo.id, label: uo.alias, kind: 'unitOperation', icon: uo.done ? 'uo-done' : 'symbol-method', tooltip: `${uo.code} ${uo.name}` }, { kind: 'uo', wf, uo }),
      ),
      ...(partial ? [] : [put({ id: `add-uo:${wf.path}`, label: t('experiments.addUo'), kind: 'unitOperation', icon: 'add' }, { kind: 'addUo', wf })]),
    ];
    return put(
      { id: wf.id, label: wf.alias, kind: 'workflow', icon: 'symbol-class', tooltip: `${posix.basename(wf.path)}`, children },
      { kind: 'workflow', exp, wf },
    );
  };

  const experimentTree = (exp: ExpNode): TreeNode => {
    const partial = found.partial.has(exp.id);
    const folders = (['images', 'resources'] as const).flatMap((name) => {
      const count = exp[name];
      return count === undefined ? [] : [put({ id: `folder:${exp.dir}/${name}`, label: name, kind: 'experiment', icon: 'folder', tooltip: `${exp.dir}/${name}` }, { kind: 'folder', exp, name, count })];
    });
    const children = [
      ...exp.workflows.map((wf) => workflowTree(exp, wf)),
      ...(partial
        ? []
        : [
            put({ id: `readme:${exp.dir}`, label: 'README', kind: 'experiment', icon: 'readme', tooltip: exp.readme }, { kind: 'readme', exp }),
            ...folders,
            put({ id: `add-wf:${exp.dir}`, label: t('experiments.addWorkflow'), kind: 'experiment', icon: 'add' }, { kind: 'addWorkflow', exp }),
          ]),
    ];
    return put(
      { id: exp.id, label: experimentLabel(exp), kind: 'experiment', icon: 'beaker', tooltip: tipOf(exp), children },
      { kind: 'experiment', exp },
    );
  };

  const treeNodes: TreeNode[] = groups.map((g) =>
    put({ id: `group:${g.key}`, label: g.label, kind: 'experimentStatus', children: g.items.map(experimentTree) }, { kind: 'group' }),
  );
  const groupCount = new Map(groups.map((g) => [`group:${g.key}`, g.items.length]));

  // 처음 보는 묶음은 펼친다(사람이 접은 것은 그대로)
  const fresh = treeNodes.filter((g) => !seeded.current.has(g.id));
  useEffect(() => {
    if (fresh.length === 0) return;
    fresh.forEach((g) => seeded.current.add(g.id));
    setExpanded((prev) => new Set([...prev, ...fresh.map((g) => g.id)]));
  });

  // 열린 노트의 갈래(묶음, 실험, 워크플로)를 펼친다: 노트가 바뀔 때 한 번
  const activeExp = activePath ? nodes.find((n) => activePath.toLowerCase().startsWith(`${n.dir.toLowerCase()}/`)) : undefined;
  const activeWf = activeExp?.workflows.find((w) => samePath(w.path, activePath));
  useEffect(() => {
    if (!activePath || !activeExp || revealed.current === activePath) return;
    revealed.current = activePath;
    const group = groups.find((g) => g.items.some((n) => n.id === activeExp.id));
    setExpanded((prev) => new Set([...prev, ...(group ? [`group:${group.key}`] : []), activeExp.id, ...(activeWf ? [activeWf.id] : [])]));
  });

  // 커서가 든 UO: 열린 워크플로에서 커서 줄이 그 구역(제목 줄부터 다음 #~### 제목 앞까지) 안에 드는 UO.
  // 마지막 UO 뒤의 `## Conclusions` 같은 글은 어느 UO 에도 들지 않는다.
  const currentUo =
    !noteHidden && activeWf !== undefined && cursorLine !== undefined
      ? [...activeWf.uos].reverse().find((u) => u.line <= cursorLine - 1 && (u.end === undefined || cursorLine - 1 < u.end))
      : undefined;

  const shownExpanded = searching ? new Set([...expanded, ...treeNodes.map((g) => g.id), ...found.expanded]) : expanded;

  const toggle = (id: string, open: boolean) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (open) next.add(id);
      else next.delete(id);
      return next;
    });

  /** 실험 하나를 고친 뒤 그 실험만 다시 읽는다(감시 이벤트를 기다리지 않는다). */
  const changed = (folder: string, run: () => Promise<unknown>) => async () => {
    kept.current.add(folder);
    try {
      await run();
    } finally {
      forget([folder]);
      reload();
    }
  };

  /** README 체크리스트에서 그 워크플로를 체크하거나 푼다(상태 아이콘과 맥락 메뉴). */
  const tickWorkflow = (exp: ExpNode, wf: WfNode) => changed(exp.dir, () => toggleWorkflowTick(ctx, exp.dir, posix.basename(wf.path)));

  const addWorkflow = (exp: ExpNode) => void runCommand(ctx, () => createWorkflow(ctx, undefined, { experimentDir: exp.dir }));
  const addUo = (wf: WfNode) => void runCommand(ctx, () => insertUnitOp(ctx, undefined, { workflowPath: wf.path }));

  const activate = (node: TreeNode) => {
    const item = items.get(node.id);
    if (!item) return;
    switch (item.kind) {
      case 'experiment':
      case 'readme':
        void runCommand(ctx, () => ctx.openFile(item.exp.readme));
        break;
      case 'workflow':
        void runCommand(ctx, () => ctx.openFile(item.wf.path));
        break;
      case 'uo':
        void runCommand(ctx, () => ctx.openFile(item.wf.path, { line: item.uo.line }));
        break;
      case 'folder': {
        const dir = `${item.exp.dir}/${item.name}`;
        if (ctx.revealInFiles) ctx.revealInFiles(dir);
        else ctx.showPanel('files');
        break;
      }
      case 'addWorkflow':
        addWorkflow(item.exp);
        break;
      case 'addUo':
        addUo(item.wf);
        break;
    }
  };

  const menuFor = (node: TreeNode): MenuItem[] => {
    const item = items.get(node.id);
    if (item?.kind === 'experiment') {
      const { dir: folder, status, entry } = item.exp;
      return [
        { label: t('experiments.addWorkflow'), run: () => createWorkflow(ctx, undefined, { experimentDir: folder }) },
        { label: coreT('Change experiment status'), run: changed(folder, () => changeExperimentStatus(ctx, folder)) },
        { label: coreT('Toggle discussion flag'), run: changed(folder, () => toggleDiscussionFlag(ctx, folder)) },
        ...((entry.markers ?? 0) > 0 ? [{ label: coreT('Show @issue markers'), run: () => showMarkers(host, folder) }] : []),
        ...(status === 'failed' || status === 'needs-repeat' ? [{ label: coreT('Retry this experiment'), run: () => retryExperiment(ctx, folder) }] : []),
        ...githubMenuItems(ctx, folder),
      ];
    }
    if (item?.kind === 'workflow') {
      const { exp, wf } = item;
      const ticked = (fullWorkflows.get(wf.id) ?? wf).ticked;
      return [
        { label: t('experiments.addUo'), run: () => insertUnitOp(ctx, undefined, { workflowPath: wf.path }) },
        // 상태 아이콘은 탭 정지가 아니다: 키보드(메뉴 키, Shift+F10)로는 여기서 체크한다
        { label: ticked ? t('experiments.wf.untick') : t('experiments.wf.tick'), run: tickWorkflow(exp, wf) },
      ];
    }
    // 카탈로그 트리
    if (node.kind === 'workflow') {
      const wf = node.payload as WorkflowItem;
      // 플러그인처럼 대상은 열린 노트의 실험이다
      return [{ label: coreT('Create workflow'), run: () => createWorkflow(ctx, wf) }];
    }
    if (node.kind === 'unitOperation') {
      const { opType, ...op } = node.payload as UnitOperationItem & { opType: 'hw' | 'sw' };
      return [{ label: coreT('Insert unit operation'), run: () => insertUnitOp(ctx, { op, kind: opType }) }];
    }
    return [];
  };

  const context = (node: TreeNode, anchor: MenuAnchor) => {
    const list = menuFor(node);
    if (list.length > 0) openMenu(ctx, anchor, list);
  };

  const isCurrent = (node: TreeNode) => {
    const item = items.get(node.id);
    if (!activePath || !item || noteHidden) return false;
    if (item.kind === 'workflow') return samePath(item.wf.path, activePath);
    if (item.kind === 'readme') return samePath(item.exp.readme, activePath);
    return false;
  };

  const state = (node: TreeNode): TreeState | undefined => {
    const item = items.get(node.id);
    if (item?.kind === 'experiment') {
      const label = item.exp.status ? statusLabel(item.exp.status) : t('experiments.noStatus');
      return { icon: SHAPE_ICON[statusShape(item.exp.status)], label };
    }
    if (item?.kind === 'workflow') {
      const full = fullWorkflows.get(item.wf.id) ?? item.wf;
      const s = workflowState(full);
      const { exp, wf } = item;
      return {
        icon: WF_ICON[s],
        label:
          s === 'ticked'
            ? t('experiments.wf.ticked')
            : s === 'tickedOpen'
              ? t('experiments.wf.tickedOpen', uoDone(full), full.uos.length)
              : s === 'partial'
                ? t('experiments.wf.partial')
                : t('experiments.wf.none'),
        onClick: () => void runCommand(ctx, tickWorkflow(exp, wf)),
      };
    }
    return undefined;
  };

  const meta = (node: TreeNode): string | undefined => {
    const item = items.get(node.id);
    if (!item) return undefined;
    if (item.kind === 'group') return String(groupCount.get(node.id) ?? '');
    if (item.kind === 'experiment') {
      const p = item.exp.entry.progress;
      return p && p.total > 0 ? `${p.done}/${p.total}` : undefined;
    }
    if (item.kind === 'workflow') {
      // 찾기로 UO 일부만 남아도 진행은 워크플로 전체로 센다
      const wf = fullWorkflows.get(item.wf.id) ?? item.wf;
      return wf.uos.length > 0 ? `${uoDone(wf)}/${wf.uos.length}` : undefined;
    }
    if (item.kind === 'folder') return String(item.count);
    return undefined;
  };

  const code = (node: TreeNode): ReactNode | undefined => {
    const item = items.get(node.id);
    if (item?.kind === 'workflow') return marked(item.wf.code, found.marks.get(`${item.wf.id}:code`));
    if (item?.kind === 'uo') return marked(item.uo.code, found.marks.get(`${item.uo.id}:code`));
    return undefined;
  };

  /** 실험 줄의 GitHub 상태(spec §5.1). 연결이 없으면 없다. */
  const badge = (node: TreeNode): TreeBadge | undefined => {
    const item = items.get(node.id);
    return item?.kind === 'experiment' ? statusBadge(githubStatuses[item.exp.dir]) : undefined;
  };

  const actions = (node: TreeNode): TreeAction[] | undefined => {
    const item = items.get(node.id);
    if (item?.kind === 'experiment') return [{ icon: 'plus', label: t('experiments.addWorkflow'), run: () => addWorkflow(item.exp) }];
    if (item?.kind === 'workflow') return [{ icon: 'plus', label: t('experiments.addUo'), run: () => addUo(item.wf) }];
    return undefined;
  };

  const rowClass = (node: TreeNode): string | undefined => {
    const item = items.get(node.id);
    if (!item) return undefined;
    if (item.kind === 'group') return 'tree-group';
    if (item.kind === 'addWorkflow' || item.kind === 'addUo') return 'ghost';
    if (item.kind === 'uo' && currentUo && item.uo.id === currentUo.id && item.wf.id === activeWf?.id) return 'uo-current';
    return undefined;
  };

  const newExperiment = () => void runCommand(ctx, commandById('create-experiment') ?? (() => createExperiment(ctx)));
  const collapseAll = () => setExpanded(new Set(treeNodes.map((g) => g.id)));

  const catalogTree = useMemo(
    () =>
      catalog
        ? relabelCatalog(
            buildWorkflowTree(catalog, {
              describe: (id, d) => catalogDescription(id, d, coreLocale()),
              equipment: coreT('Equipment'),
              software: coreT('Software'),
            }),
          )
        : [],
    // lang: 뿌리 이름과 설명이 지역화된다
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [catalog, lang],
  );

  /** 카탈로그 항목의 주 동작 대상: 워크플로는 열린 노트의 실험, UO 는 열린 워크플로 노트. 없으면 undefined(단추가 꺼진다). */
  const catalogTarget = (entry: CatalogEntry): CatalogTarget | undefined => {
    if (entry.kind === 'workflow') {
      if (!activeExp) return undefined;
      const exp = activeExp;
      const item = entry.item;
      return { label: experimentLabel(exp), run: () => void runCommand(ctx, () => createWorkflow(ctx, item, { experimentDir: exp.dir })) };
    }
    if (!activeWf) return undefined;
    const chosen = { op: entry.item, kind: entry.opType };
    return { label: `${activeWf.code} ${activeWf.alias}`.trim(), run: () => void runCommand(ctx, () => insertUnitOp(ctx, chosen)) };
  };

  const activateCatalog = (node: TreeNode, el?: HTMLElement) => {
    const entry = catalogEntry(node);
    if (entry && el) setPopover({ entry, anchor: el });
  };

  return (
    <div className="workflows-panel experiments-panel">
      <div className="nav-header">
        <span className="nav-header-title">{t('experiments.title')}</span>
        <div className="nav-header-actions">
          <button type="button" className="ibtn" aria-label={t('experiments.new')} title={t('experiments.new')} onClick={newExperiment}>
            <Icon name="flask-conical" />
          </button>
          <button type="button" className="ibtn" aria-label={t('experiments.collapseAll')} title={t('experiments.collapseAll')} onClick={collapseAll}>
            <Icon name="chevrons-up-down" />
          </button>
        </div>
      </div>
      <div className="workflows-controls">
        <input
          type="search"
          role="searchbox"
          className="workflows-search"
          aria-label={t('experiments.filterLabel')}
          placeholder={t('experiments.filter')}
          value={query}
          onChange={(e) => {
            kept.current.clear();
            setQuery(e.target.value);
          }}
        />
        <SelectMenu<GroupBy>
          className="workflows-group-by"
          label={t('experiments.groupBy')}
          value={groupBy}
          onChange={(value) => {
            const next = GROUPS.includes(value) ? value : 'status';
            setGroupBy(next);
            ctx.updateSettings({ workflowViewGroupBy: settingFromGroupBy(next) });
          }}
          options={[
            { value: 'status', label: t('experiments.groupBy.status') },
            { value: 'experimenter', label: t('experiments.groupBy.experimenter') },
            { value: 'project', label: t('experiments.groupBy.project') },
            { value: 'updated', label: t('experiments.groupBy.updated') },
            { value: 'discuss', label: t('experiments.groupBy.discuss') },
          ]}
        />
      </div>
      {entries === undefined ? (
        <p className="workflows-hint" role="status">
          {t('workflows.loading')}
        </p>
      ) : (
        <>
          {treeNodes.length === 0 && (
            <p className="workflows-hint" role="status">
              {searching ? t('experiments.noMatch') : t('experiments.empty')}
            </p>
          )}
          <TreeView
            nodes={treeNodes}
            label={t('experiments.tree')}
            expanded={shownExpanded}
            onToggle={toggle}
            onActivate={activate}
            onContext={context}
            isCurrent={isCurrent}
            scrollCurrent
            rowClass={rowClass}
            meta={meta}
            code={code}
            state={state}
            badge={badge}
            actions={actions}
            renderLabel={(node) => marked(node.label, found.marks.get(node.id))}
          />
        </>
      )}
      {catalog && (
        <section className="catalog-section">
          <button type="button" className="catalog-head" aria-expanded={catalogOpen} onClick={() => setCatalogOpen((v) => !v)}>
            <Icon name="chevron-right" size={14} className="catalog-chevron" />
            <Icon name="book-open" className="catalog-icon" />
            <span className="catalog-title">{t('workflows.catalog')}</span>
            <span className="tree-meta">{t('catalog.meta', String(catalog.workflows.length), String(catalog.hwUnitOps.length + catalog.swUnitOps.length))}</span>
          </button>
          {catalogOpen && (
            <TreeView
              nodes={catalogTree}
              label={t('workflows.catalog')}
              expanded={expanded}
              onToggle={toggle}
              onActivate={activateCatalog}
              onContext={context}
              code={catalogCode}
              meta={catalogMeta}
            />
          )}
        </section>
      )}
      {popover && (
        <CatalogPopover
          anchor={popover.anchor}
          entry={popover.entry}
          target={catalogTarget(popover.entry)}
          locale={coreLocale()}
          onClose={({ restoreFocus }) => {
            const anchor = popover.anchor;
            setPopover(undefined);
            if (restoreFocus && anchor.isConnected) anchor.focus();
          }}
        />
      )}
    </div>
  );
}
