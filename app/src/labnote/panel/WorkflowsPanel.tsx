import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ExperimentEntry, ExperimentGrouping, TreeNode, UnitOperationItem, WorkflowItem } from '@labnoteo/core';
import { buildExperimentTree, buildWorkflowTree, filterExperiments } from '@labnoteo/core';
import { loadUnitOperations, loadWorkflows } from '@labnoteo/core/lib/workflowDataLoader';
import { t } from '../../i18n/t';
import { useLang } from '../../i18n/useLang';
import { vaultRefresh, type CommandContext } from '../commands/context';
import { changeExperimentStatus, createExperiment, retryExperiment, toggleDiscussionFlag } from '../commands/experiment';
import { commandById } from '../commands/registry';
import { runCommand } from '../commands/runCommand';
import { insertUnitOp } from '../commands/unitOp';
import { createWorkflow } from '../commands/workflow';
import { coreLocale, coreT } from '../i18n';
import { VAULT_ROOT } from '../paths';
import { catalogDescription } from '../port/aliasHints';
import { CATALOG_DIR, ensureVaultCatalogs } from '../port/catalogUpdate';
import { statusNames } from '../port/status';
import { discussWords, keptExperiments, showMarkers, treeLabels } from '../port/workflowView';
import { openMenu, type MenuAnchor, type MenuItem } from '../ui/menuStore';
import { ExperimentEntryCache } from './experimentEntries';
import { TreeView } from './TreeView';
import { SelectMenu } from '../../ui/SelectMenu';
import { touchesDir, useVaultChanges } from './useVaultChanges';

export interface WorkflowsPanelProps {
  ctx: CommandContext;
  /** 편집기에 열린 노트: 그 노트의 실험 줄을 표시한다. */
  activePath?: string;
}

interface Catalog {
  workflows: WorkflowItem[];
  hwUnitOps: UnitOperationItem[];
  swUnitOps: UnitOperationItem[];
}

const GROUPS: readonly ExperimentGrouping[] = ['status', 'project', 'author', 'discuss', 'updated'];

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

/**
 * Workflows 사이드 패널(플러그인 views/workflowView.ts 의 앱판): 실험 찾기, 묶는 기준, 새 실험 단추, 실험 트리,
 * 카탈로그 트리. 트리의 글은 그릴 때 만든다: 언어를 바꾸면 다시 읽지 않고 이름만 바뀐다.
 * - 첫 그리기는 README 와 폴더 목록만 읽고, `@issue` 마커 수는 뒤에서 도착하는 대로 다시 그린다.
 * - 보관함 변경(useVaultChanges)과 명령의 vaultRefresh 에 바뀐 실험만 버리고 뒤에서 다시 읽는다. 새 줄이 올 때까지 옛 줄을 둔다.
 * - 맥락 메뉴(플러그인 workflowView.ts:449-534)의 동작은 모두 runCommand 를 거친다(메뉴 층이 감싼다).
 */
export function WorkflowsPanel({ ctx, activePath }: WorkflowsPanelProps) {
  useLang();
  const { host } = ctx;
  const cache = useMemo(() => new ExperimentEntryCache(host.fs), [host]);
  const [entries, setEntries] = useState<ExperimentEntry[]>();
  const [catalog, setCatalog] = useState<Catalog>();
  const [query, setQuery] = useState('');
  const [groupBy, setGroupBy] = useState<ExperimentGrouping>(ctx.settings.workflowViewGroupBy);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set(['experiments']));
  /** 이 패널에서 바꾼 실험: 찾기에 더는 맞지 않아도 남긴다(다시 우클릭해 되돌릴 수 있게, 플러그인 #356). */
  const kept = useRef(new Set<string>());
  /** 한 번 펼친 묶음: 다시 그려도 사람이 접은 묶음을 다시 펼치지 않는다. */
  const seeded = useRef(new Set<string>());
  const live = useRef(true);
  const generation = useRef(0);
  const cancelCount = useRef<() => void>();

  const reload = useCallback(() => {
    const gen = ++generation.current;
    cancelCount.current?.();
    void cache
      .all()
      .then((next) => {
        if (!live.current || gen !== generation.current) return;
        setEntries(next);
        cancelCount.current = cache.countMarkers((folder, n) => {
          if (!live.current || gen !== generation.current) return;
          setEntries((prev) => prev?.map((e) => (e.folder === folder ? { ...e, markers: n } : e)));
        });
      })
      .catch((err) => console.error('[labnoteo] reading experiments failed:', err));
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
      cache.invalidate('all');
      reload();
      reloadCatalog();
    });
    return () => {
      live.current = false;
      cancelCount.current?.();
      unsubscribe();
    };
  }, [cache, reload, reloadCatalog]);

  useVaultChanges((paths) => {
    cache.invalidate(paths);
    reload();
    // 카탈로그 파일이 밖에서 바뀌면(git pull, 다른 편집기) 카탈로그 트리도 다시 읽는다
    if (paths === 'all' || touchesDir(paths, CATALOG_DIR)) reloadCatalog();
  });

  const all = entries ?? [];
  const found = filterExperiments(all, query, discussWords(host), statusNames(host));
  const shown = keptExperiments(all, found, kept.current);
  const experimentTree = buildExperimentTree(shown, treeLabels(host), groupBy);
  const groups = experimentTree.children ?? [];
  const fresh = groups.filter((g) => !seeded.current.has(g.id));
  useEffect(() => {
    if (fresh.length === 0) return;
    fresh.forEach((g) => seeded.current.add(g.id));
    setExpanded((prev) => new Set([...prev, ...fresh.map((g) => g.id)]));
  });
  // 찾는 동안에는 맞는 실험이 있는 묶음을 모두 펼친다(접어 둔 것이어도)
  const searching = query.trim() !== '';
  const experimentExpanded = searching ? new Set([...expanded, 'experiments', ...groups.map((g) => g.id)]) : expanded;
  const catalogTree = catalog
    ? buildWorkflowTree(catalog, {
        describe: (id, d) => catalogDescription(id, d, coreLocale()),
        equipment: coreT('Equipment'),
        software: coreT('Software'),
      })
    : [];

  const toggle = (id: string, open: boolean) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (open) next.add(id);
      else next.delete(id);
      return next;
    });

  const activate = (node: TreeNode) => {
    if (node.kind !== 'experiment') return;
    const { readmePath } = node.payload as { readmePath: string };
    void runCommand(ctx, () => ctx.openFile(readmePath));
  };

  /** 실험 하나를 고친 뒤 그 실험만 다시 읽는다(감시 이벤트를 기다리지 않는다). */
  const changed = (folder: string, run: () => Promise<unknown>) => async () => {
    kept.current.add(folder);
    try {
      await run();
    } finally {
      cache.invalidate([folder]);
      reload();
    }
  };

  const menuFor = (node: TreeNode): MenuItem[] => {
    if (node.kind === 'experiment') {
      const { folder, status } = node.payload as { folder: string; status?: string };
      const markers = all.find((e) => e.folder === folder)?.markers ?? 0;
      return [
        { label: coreT('Change experiment status'), run: changed(folder, () => changeExperimentStatus(ctx, folder)) },
        { label: coreT('Toggle discussion flag'), run: changed(folder, () => toggleDiscussionFlag(ctx, folder)) },
        ...(markers > 0 ? [{ label: coreT('Show @issue markers'), run: () => showMarkers(host, folder) }] : []),
        ...(status === 'failed' || status === 'needs-repeat'
          ? [{ label: coreT('Retry this experiment'), run: () => retryExperiment(ctx, folder) }]
          : []),
      ];
    }
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
    const items = menuFor(node);
    if (items.length > 0) openMenu(ctx, anchor, items);
  };

  const isCurrent = (node: TreeNode) => {
    if (node.kind !== 'experiment' || !activePath) return false;
    const { folder } = node.payload as { folder: string };
    return activePath.toLowerCase().startsWith(`${folder.toLowerCase()}/`);
  };

  const newExperiment = () => void runCommand(ctx, commandById('create-experiment') ?? (() => createExperiment(ctx)));

  return (
    <div className="workflows-panel">
      <div className="workflows-controls">
        <input
          type="search"
          role="searchbox"
          className="workflows-search"
          aria-label={t('workflows.filterLabel')}
          placeholder={t('workflows.filter')}
          value={query}
          onChange={(e) => {
            kept.current.clear();
            setQuery(e.target.value);
          }}
        />
        <SelectMenu<ExperimentGrouping>
          className="workflows-group-by"
          label={t('workflows.groupBy')}
          value={groupBy}
          onChange={(value) => {
            const next = GROUPS.includes(value) ? value : 'status';
            setGroupBy(next);
            ctx.updateSettings({ workflowViewGroupBy: next });
          }}
          options={[
            { value: 'status', label: t('workflows.groupBy.status') },
            { value: 'project', label: t('workflows.groupBy.project') },
            { value: 'author', label: t('workflows.groupBy.author') },
            { value: 'discuss', label: t('workflows.groupBy.discuss') },
            { value: 'updated', label: t('workflows.groupBy.updated') },
          ]}
        />
        <button type="button" onClick={newExperiment}>
          {t('workflows.newExperiment')}
        </button>
      </div>
      {entries === undefined ? (
        <p className="workflows-hint" role="status">
          {t('workflows.loading')}
        </p>
      ) : (
        <>
          {searching && found.length === 0 && (
            <p className="workflows-hint" role="status">
              {coreT(
                'No experiment matches "{0}". The search reads folder names, titles, projects, authors, statuses, workflow note names, and dates written with "-" (last updated or created).',
                query.trim(),
              )}
            </p>
          )}
          <TreeView
            nodes={[experimentTree]}
            label={t('workflows.experiments')}
            expanded={experimentExpanded}
            onToggle={toggle}
            onActivate={activate}
            onContext={context}
            isCurrent={isCurrent}
          />
        </>
      )}
      {catalog && (
        <TreeView nodes={catalogTree} label={t('workflows.catalog')} expanded={expanded} onToggle={toggle} onActivate={activate} onContext={context} />
      )}
    </div>
  );
}
