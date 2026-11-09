// Ported from app/vendor/labnoteo/src/views/sampleView.ts:114-138 sha256:1ff43d502c60ec3f
// Ported from app/vendor/labnoteo/src/views/sampleView.ts:165-238 sha256:148e150b11d644f3
// Ported from app/vendor/labnoteo/src/views/sampleView.ts:240-430 sha256:d206b838df300f44
// Ported from app/vendor/labnoteo/src/views/sampleView.ts:433-444 sha256:006f7179e22519c2
// labnoteO 0.140.2, Apache-2.0.
// Changes: only the pure parts of the SampleTreeView class are kept; the React panel (samples/SamplesPanel.tsx) holds the state, timers and DOM. buildChrome (114-138) becomes sampleViewHint (the hint sentence) and the SAMPLE_SEARCH_MS constant; refresh (165-177) becomes loadSampleTree, which returns the nodes and the Local folder it rendered instead of storing them, takes the Local folder from the caller (the panel's active note) and the Global one from env.globalFolder(); sameFolderNotice takes the translator; renderCurrent (205-219) becomes visibleSampleTree; seedInitialExpansion returns a Set (every node id while searching, as renderCurrent's throwaway set) instead of filling this.expanded once — the panel seeds once; onContext/onTypeContext/onSampleContext (240-273, 291-430) become typeMenuItems/sampleMenuItems, which return the item ids in the plugin's order instead of building an Obsidian Menu (the panel binds them to the flows), with addPartbankMenuItems removed (SP6, D2); showUsages (275-289) takes env and the folder: pickModal → env.host.pick, new Notice → env.host.notify('info', …), plugin.host.openFile → env.openFile; scheduleRefresh's 300 ms becomes SAMPLE_PANEL_REFRESH_MS; plugin.t → the core Translator (named `translate`, since the app catalog test reads a bare one-letter t call as an app key); plugin.settings.globalSampleFolder → env.globalFolder(); collectNodeIds is exported.
import { buildSampleTree, filterSampleTree, type TreeNode, type Translator } from '@labnoteo/core';
import { isSameSampleFolder, type SampleRecord } from '@labnoteo/core/lib/sampleStorage';
import { getSampleDisplayMeta } from '@labnoteo/core/lib/sampleUtils';
import type { SampleEnv } from '../../samples/env';
import type { SampleScope } from './sampleScope';
import { sampleUsageSpots, usageSpotLabel } from './sampleQuery';

/** The search box filters this long after the last keystroke. */
export const SAMPLE_SEARCH_MS = 200;
/** Bursts of refresh triggers (active note, registry writes) coalesce into one re-read after this long. */
export const SAMPLE_PANEL_REFRESH_MS = 300;

export interface SampleTypePayload {
  scope: SampleScope;
  type: string;
}

export interface SamplePayload {
  scope: SampleScope;
  type: string;
  id: string;
  record: SampleRecord;
}

export type SampleMenuItem =
  | 'show'
  | 'copyId'
  | 'insertReference'
  | 'usages'
  | 'edit'
  | 'moveGlobal'
  | 'moveLocal'
  | 'changeType'
  | 'discard'
  | 'undiscard'
  | 'delete';

/** The hint line above the tree (buildChrome). */
export function sampleViewHint(translate: Translator): string {
  return translate(
    'Type @dna (or another type) in a note, or right-click → "{0}" to register a sample.',
    translate('Add sample'),
  );
}

/**
 * refresh: both scope trees, with a Local root that is the Global folder again
 * replaced by the same-folder notice. Returns the Local folder it rendered, which
 * the menu actions write to.
 */
export async function loadSampleTree(env: SampleEnv, local: string): Promise<{ nodes: TreeNode[]; local: string }> {
  const global = env.globalFolder();
  const types = getSampleDisplayMeta(env.settings().customSampleTypes).types;

  const labels = { discarded: env.t('(discarded)') };
  const nodes = (await buildSampleTree(env.fs, { local, global }, types, labels)).map((root) =>
    (root.payload as { sameFolder?: boolean } | undefined)?.sameFolder ? sameFolderNotice(root, env.t) : root,
  );
  return { nodes, local };
}

/**
 * The Local root of a note outside any experiment, whose Local folder is the
 * Global one: one line saying so instead of empty type nodes, whose "Add
 * sample" would write to Global anyway (#111). No click or menu.
 */
export function sameFolderNotice(root: TreeNode, translate: Translator): TreeNode {
  return {
    ...root,
    children: [
      {
        id: `${root.id}:sameFolder`,
        label: translate(
          'Notes outside an experiment use the Global samples below. Open an experiment note to see its samples.',
        ),
        kind: 'sampleDetail',
      },
    ],
  };
}

/**
 * Render the loaded tree through the active search filter. A non-empty query
 * forces every surviving node open (so matches are visible without clicking),
 * using a throwaway expanded set so the user's manual collapse state is
 * untouched once the search is cleared.
 */
export function visibleSampleTree(
  nodes: TreeNode[],
  query: string,
  expanded: ReadonlySet<string>,
): { nodes: TreeNode[]; expanded: ReadonlySet<string> } {
  const shown = filterSampleTree(nodes, query);
  const searching = query.trim().length > 0;
  return { nodes: shown, expanded: searching ? collectNodeIds(shown) : expanded };
}

/**
 * On the first render, open both scope roots (so Global samples are visible
 * without a click) and any type node that actually holds samples. Type nodes
 * whose only child is the synthetic "No samples" placeholder stay collapsed —
 * hence the `kind === 'sample'` check rather than `children.length`.
 * While searching, every node is open.
 */
export function seedInitialExpansion(nodes: TreeNode[], searching: boolean): Set<string> {
  if (searching) return collectNodeIds(nodes);
  const expanded = new Set<string>();
  for (const root of nodes) {
    expanded.add(root.id);
    for (const typeNode of root.children ?? []) {
      if (typeNode.children?.some((c) => c.kind === 'sample')) {
        expanded.add(typeNode.id);
      }
    }
  }
  return expanded;
}

/** Type node: create a new sample in that scope's folder. */
export function typeMenuItems(node: TreeNode): Array<'addSample'> {
  return node.kind === 'sampleType' ? ['addSample'] : [];
}

/** Sample node: copy / insert reference / view usages / edit / delete. */
export function sampleMenuItems(node: TreeNode, renderedLocal: string, globalFolder: string): SampleMenuItem[] {
  if (node.kind !== 'sample') return [];
  const sample = node.payload as SamplePayload;
  const items: SampleMenuItem[] = ['show', 'copyId', 'insertReference', 'usages', 'edit'];
  // Outside an experiment Local is the Global folder: there is no Local to move to (#159).
  const noLocal = isSameSampleFolder(renderedLocal, globalFolder);
  if (sample.scope === 'local' || !noLocal) {
    items.push(sample.scope === 'local' ? 'moveGlobal' : 'moveLocal');
  }
  items.push('changeType');
  const discarded = Boolean(sample.record.discarded);
  items.push(discarded ? 'undiscard' : 'discard');
  items.push('delete');
  return items;
}

/** The places that use a sample, picked from a list to open at the reference (#130, #291). */
export async function showUsages(env: SampleEnv, folder: string, sample: { type: string; id: string }): Promise<void> {
  const spots = await sampleUsageSpots(env, folder, sample.type, sample.id);
  if (spots.length === 0) {
    env.host.notify('info', env.t('{0} is not used in any note.', sample.id));
    return;
  }
  const notes = new Set(spots.map((s) => s.path)).size;
  const spot = await env.host.pick(
    spots.map((s) => ({ label: s.path, description: usageSpotLabel(env.t, s), value: s })),
    { title: env.t('Notes using {0} ({1})', sample.id, String(notes)) },
  );
  if (spot) await env.openFile(spot.path, { line: spot.line, ch: spot.ch });
}

/** Collect every node id in a tree (used to force-expand search results). */
export function collectNodeIds(nodes: TreeNode[]): Set<string> {
  const ids = new Set<string>();
  const walk = (list: TreeNode[]): void => {
    for (const node of list) {
      ids.add(node.id);
      if (node.children) walk(node.children);
    }
  };
  walk(nodes);
  return ids;
}
