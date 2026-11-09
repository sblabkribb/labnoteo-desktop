// Ported from app/vendor/labnoteo/src/commands.ts:142-330 sha256:684fab5bd496e1ac
// Ported from app/vendor/labnoteo/src/commands.ts:503-538 sha256:bb9a0f969e8e60fc
// labnoteO 0.140.2, Apache-2.0.
// Changes: resolveLabnoteDir(app, host) async -> resolveLabnoteDir(host, activePath) sync and exported; `app.workspace.getActiveFile()?.path` -> the `active` parameter.
// Changes: experimentFolderNames takes `Pick<LabnoteHost, 'fs'>` instead of `LabnoteHost`.
// Changes: warnIfWindowsPathTooLong(app, host, path) -> warnIfWindowsPathTooLong(host, vaultRoot, path), exported, host narrowed to notify and t.
// Changes: windowsPathsOver(app, ...) -> windowsPathsOver(vaultRoot, ...): the base path is the vault root the app opened; no `Platform.isWin` check (the app is Windows only).
// Changes: README is imported from ../paths; the imports below replace the top of commands.ts.
// Changes: experimentReadmes reads front matter through frontMatterText, which strips a leading UTF-8 BOM as well as CRLF.

import type { LabnoteHost, PromptHint } from '@labnoteo/core';
import { parseFrontMatterYaml } from '@labnoteo/core';
import * as posix from '@labnoteo/core/posix';
import {
  diagnoseExperimentPath,
  experimentTitleBudget,
  experimentTitleLength,
  retryOfLinkpath,
  sanitizeTitle,
} from '@labnoteo/core/lib/labnoteStructure';
import { fullPathLength, WINDOWS_PATH_MAX } from '@labnoteo/core/lib/regexUtils';
import { frontMatterText } from '../frontMatterText';
import { README } from '../paths';

/**
 * Resolve the target experiment folder from the active note's path. Warns and
 * returns undefined when no lab note (a file under `labnote/###_*`) is open.
 */
export function resolveLabnoteDir(
  host: Pick<LabnoteHost, 'notify' | 't'>,
  active: string | undefined
): string | undefined {
  // The app passes the note open in the editor (CommandContext.activePath()),
  // so resolution still works when focus is on a sidebar/tree.
  const found = active ? diagnoseExperimentPath(active) : ({ kind: 'outside' } as const);
  if (found.kind === 'ok') return found.folder;
  // A lab note in a numbered folder outside labnote/ is an experiment moved out of it (#424).
  const movedOut =
    found.kind === 'outside' && active && /\.labnote\.md$/i.test(active) && /^\d{3}_/.test(posix.basename(posix.dirname(active)))
      ? posix.dirname(active)
      : undefined;
  const misplaced = found.kind === 'nested' ? found.folder : movedOut;
  host.notify(
    'warn',
    misplaced
      ? host.t(
          '"{0}" is not recognized as an experiment: experiment folders must be directly under labnote/. Move it back to labnote/.',
          posix.basename(misplaced)
        )
      : found.kind === 'noPrefix'
        ? host.t(
            '"{0}" is not an experiment folder: its name must start with ###_ (e.g. 001_Name).',
            posix.basename(found.folder)
          )
        : host.t('Open a lab note first.')
  );
  return undefined;
}

/**
 * Names under `labnote/`, plus the `###_` folders one level down in an
 * unnumbered folder: an experiment moved into a grouping folder is no longer
 * recognised, but its number must not be handed out again (#166).
 */
export async function experimentFolderNames(host: Pick<LabnoteHost, 'fs'>): Promise<string[]> {
  const names = await host.fs.list('labnote');
  const nested: string[] = [];
  for (const name of names) {
    if (/^\d{3}_/.test(name) || name.includes('.')) continue;
    try {
      nested.push(...(await host.fs.list(posix.join('labnote', name))).filter(n => /^\d{3}_/.test(n)));
    } catch {
      // Not a folder.
    }
  }
  return [...names, ...nested];
}

/** An experiment folder and what its README says of it (#480, #482). */
export interface ExperimentReadme {
  /** Vault path of the folder. */
  folder: string;
  /** The README's `title`, else the folder name without its number. */
  title: string;
  /** The experiment folder the README's `retry_of` links to. */
  retryOf?: string;
}

/**
 * The experiment folders {@link experimentFolderNames} counts, as paths (one
 * in an unnumbered grouping folder has no README path by its name alone), with
 * each README's title and `retry_of`.
 */
export async function experimentReadmes(host: Pick<LabnoteHost, 'fs'>): Promise<ExperimentReadme[]> {
  if (!(await host.fs.exists('labnote'))) return [];
  const folders: string[] = [];
  for (const name of await host.fs.list('labnote')) {
    if (/^\d{3}_/.test(name)) {
      folders.push(posix.join('labnote', name));
      continue;
    }
    if (name.includes('.')) continue;
    try {
      const inner = await host.fs.list(posix.join('labnote', name));
      folders.push(...inner.filter(n => /^\d{3}_/.test(n)).map(n => posix.join('labnote', name, n)));
    } catch {
      // Not a folder.
    }
  }
  const out: ExperimentReadme[] = [];
  for (const folder of folders) {
    const readmePath = posix.join(folder, README);
    const named = posix.basename(folder).replace(/^\d{3}_/, '');
    let frontMatter: Record<string, unknown> = {};
    try {
      if (await host.fs.exists(readmePath)) {
        frontMatter = parseFrontMatterYaml(frontMatterText(await host.fs.read(readmePath))).frontMatter;
      }
    } catch {
      // Unreadable README: the folder name stands for the title.
    }
    const title = typeof frontMatter.title === 'string' && frontMatter.title.trim() ? frontMatter.title.trim() : named;
    const linkpath = retryOfLinkpath(frontMatter.retry_of);
    out.push({ folder, title, ...(linkpath ? { retryOf: posix.dirname(linkpath) } : {}) });
  }
  return out;
}

/**
 * The folder of the experiment in `existing` that already has `title` (#480):
 * the same README title, or the same folder name, case aside. The folder name
 * is compared uncut, so titles alike only in their first characters do not match.
 */
export function sameTitleExperiment(existing: readonly ExperimentReadme[], title: string): string | undefined {
  const wanted = title.trim().toLowerCase();
  if (!wanted) return undefined;
  const segment = sanitizeTitle(title.trim()).toLowerCase();
  return existing.find(
    e =>
      e.title.trim().toLowerCase() === wanted ||
      (!!segment && posix.basename(e.folder).replace(/^\d{3}_/, '').toLowerCase() === segment)
  )?.folder;
}

/**
 * Warn, without stopping, when a file just made is past Windows' path limit
 * once the vault's own folder is counted (#148): names are capped, but a vault
 * deep in the disk can still push the whole path over.
 */
export function warnIfWindowsPathTooLong(
  host: Pick<LabnoteHost, 'notify' | 't'>,
  vaultRoot: string,
  vaultPath: string
): void {
  const [over] = windowsPathsOver(vaultRoot, [vaultPath], WINDOWS_PATH_MAX - 1);
  if (!over) return;
  const { length } = over;
  host.notify(
    'warn',
    host.t(
      '"{0}" is {1} characters long including the vault folder, past the {2} Windows allows. Opening it on Windows (including git clones) may fail; move the vault to a shorter folder path or shorten the name.',
      posix.basename(vaultPath),
      String(length),
      String(WINDOWS_PATH_MAX - 1)
    )
  );
}

/**
 * The vault paths longer than `max` on disk once the vault's own folder is
 * put in front, longest first (#148, #348). The app runs on Windows only, so
 * the limits always apply.
 */
export function windowsPathsOver(
  vaultRoot: string,
  vaultPaths: readonly string[],
  max: number
): Array<{ path: string; length: number }> {
  const basePath = vaultRoot;
  if (!basePath) return [];
  return vaultPaths
    .map(path => ({ path, length: fullPathLength(basePath, path) }))
    .filter(p => p.length > max)
    .sort((a, b) => b.length - a.length);
}

/**
 * How much of a new experiment's title fits in its folder name (#213), or
 * which of the `existing` experiments already has it (#480). Never blocks:
 * past the cap only the folder name is cut.
 */
export function experimentTitleHint(
  host: Pick<LabnoteHost, 't'>,
  existing: readonly ExperimentReadme[] = []
): (value: string) => PromptHint {
  const budget = experimentTitleBudget();
  return value => {
    const twin = sameTitleExperiment(existing, value);
    if (twin) {
      return {
        text: host.t(
          'The experiment {0} already has this title. Record in that experiment, or give this one another title.',
          posix.basename(twin)
        ),
        warn: true,
      };
    }
    const length = experimentTitleLength(value);
    return {
      text: host.t(
        '{0}/{1} characters in the folder name. Anything longer is cut from the folder name only; the experiment title keeps it all.',
        String(length),
        String(budget)
      ),
      warn: length > budget,
    };
  };
}

/**
 * The title a retry of `title` starts from: `… 1차` becomes `… 2차`, anything
 * else gets the run suffix. Skips runs whose folder name is in `taken`
 * (experiment folder names), so retrying the first run again after a second
 * does not offer `2차` twice (#366). `familyTitles` are the titles of the
 * experiments run as one with it ({@link retryFamily}): the run comes after
 * the highest one they show and after their count, so a retry given another
 * title still counts (#482).
 */
export function retryTitle(
  host: Pick<LabnoteHost, 't'>,
  title: string,
  taken: readonly string[] = [],
  familyTitles: readonly string[] = []
): string {
  const used = new Set(taken.map(n => n.replace(/^\d{3}_/, '')));
  const free = (t: string): boolean => !used.has(sanitizeTitle(t));
  const runOf = (t: string): RegExpExecArray | null => /^(.*\S)\s*(\d+)차$/.exec(t);
  const retryOf = (t: string): RegExpExecArray | null => /^(.*\S)\s*\(retry\)(?:\s+(\d+))?$/.exec(t);
  // `(retry)` is the second run, `(retry) k` run k + 1.
  const runNumber = (t: string): number => {
    const run = runOf(t.trim());
    if (run) return Number(run[2]);
    const retry = retryOf(t.trim());
    return retry ? (retry[2] ? Number(retry[2]) + 1 : 2) : 1;
  };
  const trimmed = title.trim();
  const given = runOf(trimmed);
  const base = given ? given[1] : (retryOf(trimmed)?.[1] ?? trimmed);
  const suffixed = host.t('{0} (retry)', base);
  const nth = (k: number): string =>
    given || runOf(suffixed) ? `${base} ${k}차` : k === 2 ? suffixed : `${suffixed} ${k - 1}`;
  let n = Math.max(familyTitles.length, ...[trimmed, ...familyTitles].map(runNumber)) + 1;
  while (!free(nth(n))) n++;
  return nth(n);
}
