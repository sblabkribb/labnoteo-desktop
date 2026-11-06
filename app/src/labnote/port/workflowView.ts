// Ported from app/vendor/labnoteo/src/views/workflowView.ts:291-328 sha256:a40fe987fe71fdcd
// Ported from app/vendor/labnoteo/src/views/workflowView.ts:358-404 sha256:0c49d5cc14e302c6
// Ported from app/vendor/labnoteo/src/views/workflowView.ts:434-447 sha256:88ebcb824443ff15
// labnoteO 0.138.0, Apache-2.0.
// Changes: checklistProgress(file) -> checklistProgress(folder, items, isFile): the caller (panel/experimentEntries.ts) reads the README and lists the folder; no mtime cache, no background re-read, `getAbstractFileByPath(p) instanceof TFile` -> `isFile(p)`.
// Changes: render()'s label object -> treeLabels(host); its search words -> discussWords(host); its `kept` filter -> keptExperiments(all, found, kept). `this.plugin.t` -> `host.t`. Drawing, grouping state and the no-match text stay in WorkflowsPanel.tsx.
// Changes: showMarkers(folder) method -> showMarkers(host, folder); `this.plugin.host` -> `host`, `this.plugin.t` -> `host.t`.

import type { ExperimentEntry, ExperimentTreeLabels, LabnoteHost } from '@labnoteo/core';
import * as posix from '@labnoteo/core/posix';
import { experimentMarkerSpots } from '../../../vendor/labnoteo/src/issueMarkerIndex';

/**
 * The README's "Related Workflows" progress. Only entries whose note is
 * there count: a note moved to another experiment leaves its entry behind
 * (#287). `isFile` says whether a vault path is a file.
 */
export function checklistProgress(
  folder: string,
  items: readonly { done: boolean; fileName: string }[],
  isFile: (path: string) => boolean
): { done: number; total: number } {
  // A note listed twice counts once, by its first entry, as the checklist sync keeps it (#511).
  const counted = new Set<string>();
  const present = items.filter(item => {
    const link = item.fileName;
    const path = [posix.join(folder, link), link].find(p => isFile(p));
    if (path === undefined || counted.has(path)) return false;
    counted.add(path);
    return true;
  });
  return { done: present.filter(i => i.done).length, total: present.length };
}

/** The words a discussed experiment also matches in the search: the tooltip line and the group name. */
export function discussWords(host: Pick<LabnoteHost, 't'>): string {
  const discuss = host.t('Flagged for discussion');
  const discussGroup = host.t('Something to discuss');
  return `${discuss} ${discussGroup}`;
}

/**
 * The experiments to draw: the search's matches, plus those changed from the
 * view since the search last changed, so the change can be undone by
 * right-clicking them again (#356).
 */
export function keptExperiments(
  all: readonly ExperimentEntry[],
  found: ExperimentEntry[],
  kept: ReadonlySet<string>
): ExperimentEntry[] {
  return found.length === all.length ? found : all.filter(e => found.includes(e) || kept.has(e.folder));
}

/** The labels buildExperimentTree puts into the experiment tree, in the UI language. */
export function treeLabels(host: Pick<LabnoteHost, 't'>): ExperimentTreeLabels {
  const discuss = host.t('Flagged for discussion');
  const discussGroup = host.t('Something to discuss');
  return {
    root: host.t('Experiments'),
    noStatus: host.t('(none)'),
    discuss,
    discussGroup,
    noDiscuss: host.t('Nothing to discuss'),
    markers: host.t('@issue markers'),
    retryOf: host.t('Retry of'),
    retriedBy: host.t('Retried in'),
    retryLineage: host.t('Retry line'),
    invalidStatus: host.t('(not an allowed status)'),
    invalidStatusTooltip: host.t('Validation fails on this status. Allowed statuses: {0}'),
    missingStatus: host.t('(validation fails)'),
    missingStatusTooltip: host.t(
      'An experiment without a status fails validation. Set one with "{0}".',
      host.t('Change experiment status')
    ),
    status: host.t('Status'),
    workflows: host.t('Workflows done'),
    lastUpdated: host.t('Last updated'),
    project: host.t('Project'),
    noProject: host.t('(no project)'),
    author: host.t('Author'),
    noAuthor: host.t('(no author)'),
    unreadable: host.t('(front matter unreadable)'),
    frontMatterError: host.t('README front matter could not be read'),
  };
}

/** Pick one of the experiment's `@issue` markers and open its note at that line (#379). */
export async function showMarkers(
  host: Pick<LabnoteHost, 'fs' | 'notify' | 'pick' | 'openFile' | 't'>,
  folder: string
): Promise<void> {
  const spots = await experimentMarkerSpots(host.fs, folder);
  if (spots.length === 0) {
    host.notify('info', host.t('This experiment has no @issue markers.'));
    return;
  }
  const spot = await host.pick(
    spots.map(s => ({ label: s.title, description: `${posix.basename(s.path)}:${s.line}`, value: s })),
    { title: host.t('@issue markers of {0} ({1})', posix.basename(folder), String(spots.length)) }
  );
  if (spot) await host.openFile(spot.path, { line: spot.line - 1 });
}
