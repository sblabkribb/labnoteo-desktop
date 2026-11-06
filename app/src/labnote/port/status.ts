// Ported from app/vendor/labnoteo/src/commands.ts:577-627 sha256:33155086d85cddef
// Ported from app/vendor/labnoteo/src/commands.ts:754-830 sha256:a4afe98c5ba69f70
// Ported from app/vendor/labnoteo/src/commands.ts:1050-1081 sha256:f87bdc02cef2c8ed
// labnoteO 0.138.0, Apache-2.0.
// Changes: statusMeanings and readNoteForFrontMatterEdit are exported; statusMeanings and statusNames take `Pick<LabnoteHost, 't'>`.
// Changes: the imports below replace the top of commands.ts. The host's fs is the app's editor-aware fs, so these reads see an open note's unsaved text.

import type { ExperimentStatus, LabnoteHost } from '@labnoteo/core';
import { EXPERIMENT_STATUSES, parseFrontMatterYaml } from '@labnoteo/core';
import * as posix from '@labnoteo/core/posix';
import {
  normalizeChecklistLink,
  parseWorkflowChecklistFromReadme,
  parseWorkflowFileName,
  unitOpsAllEnded,
} from '@labnoteo/core/lib/workflowStructure';
import { experimentMarkerSpots, formatMarkerSpots } from '../../../vendor/labnoteo/src/issueMarkerIndex';

/**
 * What each status means, shown under its name in the picker, and the words
 * its search also matches (#249). The stored value stays the English term;
 * only the explanation and the search words are translated, so a Korean user
 * finds `needs-repeat` by typing 재실험.
 */
export function statusMeanings(host: Pick<LabnoteHost, 't'>): Record<ExperimentStatus, { detail: string; keywords: string }> {
  return {
    planned: {
      detail: host.t('Planned: written down, not started yet'),
      keywords: host.t('planned not started yet'),
    },
    'in-progress': {
      detail: host.t('In progress: being run now'),
      keywords: host.t('in progress running now'),
    },
    'needs-review': {
      // The GitHub issue only happens through the vault automation (#79).
      detail: host.t('Needs review: with the research automation, a push opens a GitHub issue for this experiment'),
      keywords: host.t('needs review discussion issue'),
    },
    completed: {
      detail: host.t('Completed: finished, with the results written down'),
      keywords: host.t('completed done finished'),
    },
    failed: {
      detail: host.t('Failed: it did not work'),
      keywords: host.t('failed did not work'),
    },
    discontinued: {
      detail: host.t('Discontinued: stopped on the way, not to be taken up again'),
      keywords: host.t('discontinued stopped abandoned'),
    },
    'needs-repeat': {
      detail: host.t('Needs repeat: to be run once more'),
      keywords: host.t('needs repeat again redo'),
    },
  };
}

/**
 * Each status's name in the UI language (검토 필요 for `needs-review`), the
 * part of its meaning before `:` or `—`, for the workflow view search (#333).
 * Only the name: the search words would also match needs-review on 논의.
 */
export function statusNames(host: Pick<LabnoteHost, 't'>): Record<ExperimentStatus, string> {
  const meanings = statusMeanings(host);
  return Object.fromEntries(
    EXPERIMENT_STATUSES.map(status => [status, meanings[status].detail.split(/\s*(?::|—)\s*/)[0].trim()])
  ) as Record<ExperimentStatus, string>;
}

/**
 * What to do with the `discuss` flag once marking completed is confirmed:
 * leave it, or turn it off with the status (#380).
 */
export type CompletedChoice = 'keep' | 'clear';

/**
 * Before an experiment is marked completed — the state the automation drafts
 * papers from — ask when its checklist still has unchecked workflows or
 * workflow notes without an `end_date` (#174), or when it is still up for
 * discussion: the `discuss` flag on, or `@issue` markers left in its notes
 * (#380). Undefined to cancel. Only what was found is named, so a count of
 * zero does not send the user looking (#275). With the flag on the answer
 * also says whether to turn it off, since a completed experiment left flagged
 * stays under "Something to discuss" and opens its issue again on a push.
 */
export async function confirmCompleted(
  host: LabnoteHost,
  labnoteDir: string,
  readmeBody: string,
  discuss = false
): Promise<CompletedChoice | undefined> {
  const items = parseWorkflowChecklistFromReadme(readmeBody);
  const unchecked = items.filter(i => !i.done).length;
  const noEndDate: string[] = [];
  for (const item of items) {
    let name = normalizeChecklistLink(item.fileName, labnoteDir);
    try {
      name = decodeURI(name);
    } catch {
      // Used as written.
    }
    if (name.includes('/')) continue;
    const path = posix.join(labnoteDir, name);
    if (!(await host.fs.exists(path))) continue;
    const content = (await host.fs.read(path)).replace(/\r\n/g, '\n');
    const { frontMatter } = parseFrontMatterYaml(content);
    const end = frontMatter.end_date;
    const empty = 'end_date' in frontMatter && (end === null || end === undefined || String(end).trim() === '');
    // Every unit operation's End_date filled is finished work (#355).
    if (empty && !unitOpsAllEnded(content)) noEndDate.push(name);
  }
  const spots = await experimentMarkerSpots(host.fs, labnoteDir);

  const found: string[] = [];
  // Nothing in the checklist or the folder: no work was recorded (#398).
  if (items.length === 0) {
    const names = (await host.fs.exists(labnoteDir)) ? await host.fs.list(labnoteDir) : [];
    if (!names.some(n => n !== 'README.labnote.md' && parseWorkflowFileName(n))) {
      found.push(host.t('This experiment has no workflows.'));
    }
  }
  if (unchecked > 0) found.push(host.t('{0} workflow(s) in the checklist are not checked.', String(unchecked)));
  if (noEndDate.length > 0) {
    const names =
      noEndDate.length > 3
        ? host.t('{0} (+{1} more)', noEndDate.slice(0, 3).join(', '), String(noEndDate.length - 3))
        : noEndDate.join(', ');
    found.push(host.t('{0} workflow note(s) have no end_date in their properties: {1}.', String(noEndDate.length), names));
  }
  if (discuss) found.push(host.t('The discussion flag is on.'));
  if (spots.length > 0) {
    found.push(host.t('{0} @issue marker(s) remain: {1}.', String(spots.length), formatMarkerSpots(spots, host.t)));
  }
  if (found.length === 0) return 'keep';
  const message = `${found.join(' ')} ${host.t('Mark the experiment completed anyway?')}`;
  if (!discuss) return (await host.confirm(message, { confirmLabel: host.t('Mark completed') })) ? 'keep' : undefined;
  const choice = await host.pick<CompletedChoice | 'cancel'>(
    [
      { label: host.t('Clear the discussion flag and mark completed'), value: 'clear' },
      { label: host.t('Keep the discussion flag and mark completed'), value: 'keep' },
      { label: host.t('Cancel'), value: 'cancel' },
    ],
    { title: message }
  );
  return choice === 'cancel' ? undefined : choice;
}

/**
 * Read an experiment README for a front-matter edit, refusing to continue when
 * the YAML cannot be parsed.
 *
 * Both callers change single keys with `setFrontMatterKeys`, which leaves the
 * other lines and their comments alone (#422), but they decide from the parsed
 * values. A failed parse yields an empty object, which would read as "no
 * status" or "not flagged". One unquoted colon in a value
 * (`title: EXP: 3rd try`) is enough to break the parse. Leave the note alone
 * and say which file and line to fix instead (#427).
 */
export async function readNoteForFrontMatterEdit(
  host: LabnoteHost,
  readmePath: string
): Promise<{ frontMatter: Record<string, unknown>; body: string; text: string } | undefined> {
  // `parseFrontMatterYaml` requires LF-normalised text (a bare `\n` after the
  // opening `---`); normalise CRLF so Windows-authored notes parse correctly.
  const original = (await host.fs.read(readmePath)).replace(/\r\n/g, '\n');
  const { frontMatter, body, parseError } = parseFrontMatterYaml(original);
  if (parseError) {
    host.notify(
      'warn',
      host.t(
        'Front matter of {0} could not be read, so it was left unchanged. Fix the YAML and try again: {1}',
        readmePath,
        parseError
      )
    );
    return undefined;
  }
  return { frontMatter, body, text: original };
}
