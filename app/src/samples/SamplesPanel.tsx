/**
 * Samples 사이드 탭(plan SP5 Task 25, D15): 플러그인 views/sampleView.ts 의 앱판. 순수한 부분(트리 입력, 같은 폴더 알림,
 * 펼침 씨앗, 메뉴 항목, 사용처 고르기)은 labnote/port/sampleView.ts 에 옮겨 두었고, 여기는 상태와 타이머와 그리기다.
 * - 트리는 코어 buildSampleTree(labels.discarded = coreT('(discarded)'))이고, 뿌리와 세부 줄의 앞말만 앱 번역(t)으로 바꿔 단다.
 * - Local 폴더는 열린 노트(activePath)에서 정한다. 메뉴 동작은 마지막으로 그린 Local 폴더에 쓴다(그린 뒤 노트가 바뀌어도).
 * - 다시 읽기: 처음 그릴 때 바로, 그 뒤에는 열린 노트가 바뀌거나 대장이 바뀌면(명령의 sampleEvents, 감시와 초점 복귀의
 *   samples.vaultChanged, 동기화의 registryChanged) SAMPLE_PANEL_REFRESH_MS 뒤에 한 번.
 * - 찾기는 SAMPLE_SEARCH_MS 뒤에 읽어 둔 트리를 거른다(파일을 다시 읽지 않는다). 찾는 동안은 남은 것이 모두 펼쳐지고,
 *   그동안 접고 편 것은 찾기를 지우면 버린다(사람이 정한 펼침은 그대로).
 * - 전역 샘플 추적 스위치가 꺼져 있을 때만 트리 대신 플러그인의 문장을 보인다. 실험 README 의 sample_tracking: no 는
 *   트리를 숨기지 않는다.
 * - 메뉴 동작은 메뉴 층의 runCommand 를 거친다(거절은 알림이 된다).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TreeNode } from '@labnoteo/core';
import { buildSampleReferenceText } from '@labnoteo/core/lib/sampleUtils';
import { t } from '../i18n/t';
import { useLang } from '../i18n/useLang';
import type { CommandContext } from '../labnote/commands/context';
import { coreT } from '../labnote/i18n';
import { TreeView } from '../labnote/panel/TreeView';
import { openSampleDefinition } from '../labnote/port/sampleCommands';
import { createSampleInteractive } from '../labnote/port/sampleCreate';
import { deleteSampleInteractive } from '../labnote/port/sampleDelete';
import { editSampleInteractive, setSampleDiscardedInteractive } from '../labnote/port/sampleEdit';
import { hasLocalScope, localSampleFolder } from '../labnote/port/sampleFolders';
import { insertSampleReference } from '../labnote/port/sampleInsert';
import { changeSampleTypeInteractive, moveSampleInteractive } from '../labnote/port/sampleMove';
import type { SampleScope } from '../labnote/port/sampleScope';
import {
  loadSampleTree,
  sampleMenuItems,
  sampleViewHint,
  SAMPLE_PANEL_REFRESH_MS,
  SAMPLE_SEARCH_MS,
  seedInitialExpansion,
  showUsages,
  typeMenuItems,
  visibleSampleTree,
  type SampleMenuItem,
  type SamplePayload,
  type SampleTypePayload,
} from '../labnote/port/sampleView';
import { openMenu, type MenuAnchor, type MenuItem } from '../labnote/ui/menuStore';
import { createSampleEnv, sampleEvents, type SampleEnv } from './env';
import { samples } from './sampleStore';
import { sampleTypeClass } from './typeClass';

export interface SamplesPanelProps {
  ctx: CommandContext;
  /** 편집기에 열린 노트: 그 노트의 실험이 Local 이다. */
  activePath?: string;
}

/** 코어가 영어로 다는 세부 줄의 앞말(core treeModel sampleDetailNodes). id 의 끝으로 가린다. */
const DETAIL = /:(alias|description(?::\d+)?|location|discarded)$/;

/**
 * 코어 트리의 뿌리 이름('Samples (Local)'/'Samples (Global)')과 세부 줄의 앞말('alias: ', 'description 2: ', 'location: ',
 * 'discarded: ')을 앱의 말로 바꾼 새 트리. 다른 줄(종류 줄, 'No samples', 같은 폴더 알림)은 그대로 둔다.
 */
export function relabelSampleTree(nodes: TreeNode[], tr: typeof t): TreeNode[] {
  const relabel = (node: TreeNode): TreeNode => {
    const children = node.children?.map(relabel);
    const next = children ? { ...node, children } : { ...node };
    if (node.kind === 'sampleRoot') {
      const scope = (node.payload as { scope?: SampleScope } | undefined)?.scope;
      next.label = scope === 'global' ? tr('samples.root.global') : tr('samples.root.local');
    } else if (node.kind === 'sampleDetail') {
      const field = DETAIL.exec(node.id)?.[1];
      const m = /^[a-z]+( \d+)?: ([\s\S]*)$/.exec(node.label);
      if (field && m) {
        if (field === 'alias') next.label = tr('samples.detail.alias', m[2]);
        else if (field === 'location') next.label = tr('samples.detail.location', m[2]);
        else if (field === 'discarded') next.label = tr('samples.detail.discarded', m[2]);
        else next.label = tr('samples.detail.description', m[1] ?? '', m[2]);
      }
    }
    return next;
  };
  return nodes.map(relabel);
}

interface Loaded {
  nodes: TreeNode[];
  /** 이 트리를 그린 Local 폴더: 메뉴 동작이 쓰는 곳. */
  local: string;
}

export function SamplesPanel({ ctx, activePath }: SamplesPanelProps) {
  const lang = useLang();
  const env = useMemo(() => createSampleEnv(ctx), [ctx]);
  const tracking = ctx.settings.sampleTracking;
  const folderSetting = ctx.settings.globalSampleFolder;
  const customTypes = ctx.settings.customSampleTypes;
  const [loaded, setLoaded] = useState<Loaded>();
  const [query, setQuery] = useState('');
  const [applied, setApplied] = useState('');
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  /** 찾는 동안 접고 편 것(id → 열림). 찾는 말이 바뀌면 버린다. */
  const [searchToggles, setSearchToggles] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const active = useRef(activePath);
  active.current = activePath;
  const live = useRef(true);
  const generation = useRef(0);
  /** 펼침 씨앗은 패널이 살아 있는 동안 한 번(플러그인처럼): 그 뒤에는 사람이 접은 것을 따른다. */
  const seeded = useRef(false);
  const refreshTimer = useRef<ReturnType<typeof setTimeout>>();
  const searchTimer = useRef<ReturnType<typeof setTimeout>>();

  const reload = useCallback(() => {
    const gen = ++generation.current;
    const local = localSampleFolder(active.current, env.globalFolder());
    void loadSampleTree(env, local)
      .then((next) => {
        if (!live.current || gen !== generation.current) return;
        setLoaded(next);
        if (!seeded.current) {
          seeded.current = true;
          setExpanded(seedInitialExpansion(next.nodes, false));
        }
      })
      .catch((err) => console.error('[labnoteo] reading the sample tree failed:', err));
  }, [env]);

  /** 잇단 계기를 한 번의 다시 읽기로 모은다(plugin scheduleRefresh). */
  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current !== undefined) return;
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = undefined;
      reload();
    }, SAMPLE_PANEL_REFRESH_MS);
  }, [reload]);

  useEffect(() => {
    live.current = true;
    const offEvents = sampleEvents.subscribe(() => scheduleRefresh());
    const offRegistry = samples.subscribeRegistry(() => scheduleRefresh());
    return () => {
      live.current = false;
      offEvents();
      offRegistry();
      if (refreshTimer.current !== undefined) clearTimeout(refreshTimer.current);
      refreshTimer.current = undefined;
      if (searchTimer.current !== undefined) clearTimeout(searchTimer.current);
      searchTimer.current = undefined;
    };
  }, [scheduleRefresh]);

  // 처음에는 바로 읽는다. 설정(Global 폴더, 사용자 종류)이나 언어('(discarded)' 표시)가 바뀌어도 바로 다시 읽는다.
  useEffect(() => {
    reload();
  }, [reload, folderSetting, customTypes, lang]);

  // 열린 노트가 바뀌면 Local 을 다시 정한다(첫 그리기는 위에서 했다).
  const firstPath = useRef(true);
  useEffect(() => {
    if (firstPath.current) {
      firstPath.current = false;
      return;
    }
    scheduleRefresh();
  }, [activePath, scheduleRefresh]);

  const onSearch = (value: string) => {
    setQuery(value);
    if (searchTimer.current !== undefined) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => {
      searchTimer.current = undefined;
      setApplied(value);
      setSearchToggles(new Map());
    }, SAMPLE_SEARCH_MS);
  };

  const searching = applied.trim().length > 0;
  const shown = useMemo(() => {
    if (!loaded) return { nodes: [] as TreeNode[], expanded: expanded as ReadonlySet<string> };
    const visible = visibleSampleTree(loaded.nodes, applied, expanded);
    return { nodes: relabelSampleTree(visible.nodes, t), expanded: visible.expanded };
    // lang: 다시 그릴 때 앞말을 지금 언어로
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, applied, expanded, lang]);
  const shownExpanded = useMemo(() => {
    if (!searching || searchToggles.size === 0) return shown.expanded;
    const next = new Set(shown.expanded);
    for (const [id, open] of searchToggles) {
      if (open) next.add(id);
      else next.delete(id);
    }
    return next;
  }, [searching, searchToggles, shown.expanded]);

  const toggle = (id: string, open: boolean) => {
    if (searching) {
      setSearchToggles((prev) => new Map(prev).set(id, open));
      return;
    }
    setExpanded((prev) => {
      const next = new Set(prev);
      if (open) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const context = (node: TreeNode, anchor: MenuAnchor) => {
    if (!loaded) return;
    const items = menuFor(env, node, loaded.local, active.current);
    if (items.length > 0) openMenu(ctx, anchor, items);
  };

  const nodeClass = (node: TreeNode) =>
    node.kind === 'sampleType' ? `sample-swatch ${sampleTypeClass((node.payload as SampleTypePayload).type)}` : undefined;

  if (!tracking) {
    return (
      <div className="samples-panel">
        <p className="samples-hint" role="status">
          {coreT('Sample tracking is turned off in {0}.', t('cmd.sampleSettings'))}
        </p>
      </div>
    );
  }

  return (
    <div className="samples-panel">
      <input
        type="search"
        className="samples-search"
        aria-label={coreT('Search samples')}
        placeholder={coreT('Search samples')}
        value={query}
        onChange={(e) => onSearch(e.target.value)}
      />
      <p className="samples-hint">{sampleViewHint(coreT)}</p>
      {loaded && (
        <TreeView
          nodes={shown.nodes}
          label={t('sidebar.tab.samples')}
          expanded={shownExpanded}
          onToggle={toggle}
          onActivate={() => undefined}
          onContext={context}
          nodeClass={nodeClass}
        />
      )}
    </div>
  );
}

/** 맥락 메뉴의 항목: 옮겨 온 메뉴 목록(sampleMenuItems / typeMenuItems)을 흐름에 잇는다. */
function menuFor(env: SampleEnv, node: TreeNode, renderedLocal: string, activePath: string | undefined): MenuItem[] {
  const folderOf = (scope: SampleScope) => (scope === 'global' ? env.globalFolder() : renderedLocal);
  if (node.kind === 'sampleType') {
    const { scope, type } = node.payload as SampleTypePayload;
    return typeMenuItems(node).map(() => ({
      label: coreT('Add sample'),
      run: async () => {
        // Local writes need a resolvable experiment folder; without one the
        // sample would land in an unexpected place (or the Global fallback).
        if (scope === 'local' && !hasLocalScope(activePath)) {
          env.host.notify('info', env.t('Open a note first to add a local sample.'));
          return;
        }
        await createSampleInteractive(env, { type, folder: folderOf(scope), mode: 'generate', scope });
      },
    }));
  }
  if (node.kind !== 'sample') return [];
  const sample = node.payload as SamplePayload;
  const { scope, type, id, record } = sample;
  const folder = folderOf(scope);
  const action = (item: SampleMenuItem): MenuItem => {
    switch (item) {
      case 'show':
        return {
          label: coreT('Show sample definition'),
          run: () =>
            openSampleDefinition(env, { type, id, docPath: '', resolved: { scope, folder, record }, localFolder: renderedLocal }),
        };
      case 'copyId':
        return {
          label: coreT('Copy sample ID'),
          run: async () => {
            await navigator.clipboard.writeText(id);
            env.host.notify('info', env.t('Copied: {0}', id));
          },
        };
      case 'insertReference':
        return {
          label: coreT('Insert reference'),
          run: async () => {
            const target = env.editTarget();
            if (!target) {
              env.host.notify('info', env.t('Open a note to insert into.'));
              return;
            }
            await insertSampleReference(env, target, buildSampleReferenceText(id, record.alias));
            if (record.discarded) {
              env.host.notify('info', env.t('{0} was marked discarded on {1}.', id, record.discarded));
            }
          },
        };
      case 'usages':
        return { label: coreT('View usages'), run: () => showUsages(env, folder, sample) };
      case 'edit':
        return { label: coreT('Edit sample'), run: () => editSampleInteractive(env, { folder, type, id, record }) };
      case 'moveGlobal':
      case 'moveLocal': {
        // Hand the move the exact folders this tree rendered with, so it can
        // never re-derive Local from a since-changed active file.
        const toScope: SampleScope = scope === 'local' ? 'global' : 'local';
        return {
          label: item === 'moveGlobal' ? coreT('Move to Global') : coreT('Move to Local'),
          run: () =>
            moveSampleInteractive(env, { fromScope: scope, fromFolder: folderOf(scope), toFolder: folderOf(toScope), type, id }),
        };
      }
      case 'changeType':
        return { label: coreT('Change type'), run: () => changeSampleTypeInteractive(env, { folder, type, id }) };
      case 'discard':
      case 'undiscard':
        return {
          label: item === 'undiscard' ? coreT('Unmark discarded') : coreT('Mark as discarded'),
          run: () => setSampleDiscardedInteractive(env, { folder, type, id, discarded: item === 'discard' }),
        };
      case 'delete':
        return { label: coreT('Delete sample'), run: () => deleteSampleInteractive(env, { folder, type, id }) };
    }
  };
  return sampleMenuItems(node, renderedLocal, env.globalFolder()).map(action);
}
