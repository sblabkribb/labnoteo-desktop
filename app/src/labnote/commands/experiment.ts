/**
 * 실험 명령: 만들기, 다시 하기, 상태 바꾸기, 논의 표시 전환.
 * 플러그인 commands.ts 의 createExperimentCommand(446-485), retryExperimentCommand / retryExperimentFromPalette(524-575),
 * changeExperimentStatusCommand(629-752), toggleDiscussionFlagCommand(1083-1155)를 본뜬 앱의 오케스트레이터다.
 * 앱에서 달라진 것:
 * - Obsidian 의 App 대신 CommandContext. "이 노트"는 ctx.activePath() 다.
 * - host.fs 는 편집기를 아는 fs 라서 읽기는 열린 README 의 저장 안 된 글을 본다.
 * - README 쓰기는 writeNoteThroughVault(전체 내용) 대신 processNote 변환이다: 바꿀 키(changes)는 읽은 글로 정하고,
 *   그 변환은 쓰는 순간의 노트에 적용한다. 열린 노트는 버퍼에 한 트랜잭션(되돌리기 한 번)으로 들어간다.
 * - 자동화가 없을 때('none') "Setup research automation" 안내는 붙이지 않는다(그 명령은 뒤의 하위 프로젝트에서 온다).
 * - 만든 뒤에는 ctx.refresh() 하고 README 를 연다. 경로 길이 경고는 ctx.vaultRoot 로 잰다.
 */
import { DISCUSS_FLAG_KEY, EXPERIMENT_STATUSES, copyFrontMatterKeys, isDiscussFlagged, isValidStatus, parseFrontMatterYaml, setFrontMatterKeys } from '@labnoteo/core';
import * as posix from '@labnoteo/core/posix';
import {
  createLabnoteStructure,
  getExperimentDir,
  retryFamily,
  retryOfLink,
  sanitizeTitle,
  setRetryOf,
} from '@labnoteo/core/lib/labnoteStructure';
import { experimentMarkerSpots, formatMarkerSpots } from '../../../vendor/labnoteo/src/issueMarkerIndex';
import { coreLocale, overrideOr } from '../i18n';
import { processNote } from '../openNotes';
import { frontMatterText } from '../frontMatterText';
import { README, VAULT_ROOT, samePath } from '../paths';
import {
  experimentFolderNames,
  experimentReadmes,
  experimentTitleHint,
  resolveLabnoteDir,
  retryTitle,
  warnIfWindowsPathTooLong,
  type ExperimentReadme,
} from '../port/experiments';
import { SETUP_DOC_PATH, issueAutomationState } from '../port/issueAutomation';
import { confirmCompleted, readNoteForFrontMatterEdit, statusMeanings } from '../port/status';
import type { CommandContext } from './context';
import type { Command } from './registry';
import { readmeStamp } from './stamp';

/**
 * 새 실험 폴더(labnote/###_Title)와 README 를 만들고 연다. README 경로를 돌려준다(취소하면 undefined).
 * `retryOf` 가 있으면 README 의 retry_of 가 그 실험을 가리키고, author 와 project 는 `retryReadme` 에서 온다.
 */
export async function createExperiment(
  ctx: CommandContext,
  opts: { title?: string; retryOf?: string; retryReadme?: string; readmes?: readonly ExperimentReadme[] } = {},
): Promise<string | undefined> {
  const { host } = ctx;
  const readmes = opts.readmes ?? (await experimentReadmes(host));
  const title = await host.prompt({
    title: opts.retryOf ? host.t('Retry experiment {0}', posix.basename(opts.retryOf)) : host.t('New experiment'),
    prompt: host.t('Experiment title'),
    value: opts.title,
    validate: (v) => {
      if (!v.trim()) return host.t('Title is required.');
      if (!sanitizeTitle(v.trim())) {
        return host.t('The title has no characters usable in a folder name. Add letters or numbers.');
      }
      return null;
    },
    hint: experimentTitleHint(host, readmes),
  });
  if (!title) return undefined;

  const existing = await experimentFolderNames(host);
  const structure = createLabnoteStructure(VAULT_ROOT, title.trim(), existing, undefined, { locale: coreLocale() });

  await host.fs.mkdir(structure.labnoteFolder);
  await host.fs.mkdir(structure.imagesFolder);
  await host.fs.mkdir(structure.resourcesFolder);
  let readme = structure.readmeContent;
  if (opts.retryOf) readme = setRetryOf(readme, retryOfLink(opts.retryOf));
  // 원래 README 에는 BOM 이나 CRLF 가 있을 수 있다: 읽을 수 있는 꼴로 넘긴다. 새 README 는 앱의 기본 꼴(BOM 없음, LF)이다.
  if (opts.retryReadme !== undefined) {
    readme = copyFrontMatterKeys(frontMatterText(opts.retryReadme), readme, ['author', 'project']);
  }
  await host.fs.write(structure.readmePath, readme);

  ctx.refresh();
  await ctx.openFile(structure.readmePath);
  host.notify('info', host.t('Experiment created: {0}', posix.basename(structure.labnoteFolder)));
  warnIfWindowsPathTooLong(host, ctx.vaultRoot, structure.readmePath);
  return structure.readmePath;
}

/** `folder` 의 실험을 다시 하는 실험을 만든다: 제목은 원래 것에서 다음 차수로, retry_of 는 원래 실험으로. */
export async function retryExperiment(ctx: CommandContext, folder: string): Promise<void> {
  const { host } = ctx;
  const readmePath = posix.join(folder, README);
  const text = (await host.fs.exists(readmePath)) ? await host.fs.read(readmePath) : '';
  const { frontMatter } = parseFrontMatterYaml(frontMatterText(text));
  const original =
    typeof frontMatter.title === 'string' && frontMatter.title.trim()
      ? frontMatter.title
      : posix.basename(folder).replace(/^\d{3}_/, '');
  const readmes = await experimentReadmes(host);
  const titles = new Map(readmes.map((e) => [e.folder, e.title]));
  const family = retryFamily(folder, new Map(readmes.map((e) => [e.folder, e.retryOf])));
  const familyTitles = family.map((f) => (f === folder ? original : (titles.get(f) ?? posix.basename(f))));
  await createExperiment(ctx, {
    title: retryTitle(host, original, await experimentFolderNames(host), familyTitles),
    retryOf: folder,
    retryReadme: text,
    readmes,
  });
}

/**
 * 팔레트의 "이 실험 다시 하기": 열린 노트의 실험. 모든 노트에서 보인다. 실패했거나 다시 해야 하는 실험이 아니면
 * 숨지 않고 왜 못 하는지 말한다.
 */
export async function retryFromActive(ctx: CommandContext): Promise<void> {
  const { host } = ctx;
  const folder = resolveLabnoteDir(host, ctx.activePath());
  if (!folder) return;
  const readmePath = posix.join(folder, README);
  if (!(await host.fs.exists(readmePath))) {
    host.notify('warn', host.t('This experiment has no README.labnote.md.'));
    return;
  }
  const { frontMatter } = parseFrontMatterYaml(frontMatterText(await host.fs.read(readmePath)));
  const status = typeof frontMatter.status === 'string' ? frontMatter.status.trim() : '';
  if (status !== 'failed' && status !== 'needs-repeat') {
    host.notify(
      'info',
      host.t(
        '"{0}" is for a failed or needs-repeat experiment, and {1} is {2}. Change its status first.',
        host.t('Retry this experiment'),
        posix.basename(folder),
        status || host.t('(none)'),
      ),
    );
    return;
  }
  await retryExperiment(ctx, folder);
}

/** 실험 README 의 status 를 고른 값으로 바꾼다. `experimentDir` 는 Workflows 패널이 실험을 직접 가리킬 때. */
export async function changeExperimentStatus(ctx: CommandContext, experimentDir?: string): Promise<void> {
  const { host } = ctx;
  const stamp = readmeStamp(ctx.settings);
  const labnoteDir = experimentDir ?? resolveLabnoteDir(host, ctx.activePath());
  if (!labnoteDir) return;

  const readmePath = posix.join(labnoteDir, README);
  if (!(await host.fs.exists(readmePath))) {
    host.notify('warn', host.t('This experiment has no README.labnote.md.'));
    return;
  }

  const parsed = await readNoteForFrontMatterEdit(host, readmePath);
  if (!parsed) return;
  const { frontMatter, body } = parsed;

  const current = typeof frontMatter.status === 'string' ? frontMatter.status : undefined;
  const folderName = posix.basename(labnoteDir);
  const placeholder =
    current && !isValidStatus(current)
      ? host.t('The current status "{0}" is not an allowed value. Select a status', current)
      : host.t('Select a status');
  const meanings = statusMeanings(host);
  const chosen = await host.pick(
    EXPERIMENT_STATUSES.map((status) => ({
      label: status,
      description: status === current ? host.t('current') : undefined,
      detail: meanings[status].detail,
      keywords: meanings[status].keywords.split(/\s+/).filter(Boolean),
      value: status,
    })),
    {
      title: `${host.t('Change experiment status')}: ${folderName}`,
      placeholder,
      ...(current && isValidStatus(current) && { selected: current }),
    },
  );
  if (!chosen || chosen === current) return;

  const changes: Record<string, unknown> = { status: chosen };
  let cleared = false;
  if (chosen === 'completed') {
    const choice = await confirmCompleted(host, labnoteDir, body, isDiscussFlagged(frontMatter));
    if (!choice) return;
    if (choice === 'clear') {
      changes[DISCUSS_FLAG_KEY] = undefined;
      cleared = true;
    }
  }

  // 플러그인: writeNoteThroughVault(app, host, readmePath, stamp(setFrontMatterKeys(parsed.text, changes)))
  await processNote(host.fs, readmePath, (text) => stamp(setFrontMatterKeys(text, changes)));
  let message = host.t('Experiment status changed ({0}): {1} → {2}.', folderName, current ?? host.t('(none)'), chosen);
  if (cleared) {
    message += ` ${host.t('Discussion flag cleared.')}`;
    const spots = await experimentMarkerSpots(host.fs, labnoteDir);
    if (spots.length > 0) {
      message += ` ${host.t(
        '{0} @issue marker(s) remain, so the experiment stays under "{1}": {2}.',
        String(spots.length),
        host.t('Something to discuss'),
        formatMarkerSpots(spots, host.t),
      )}`;
    }
  }
  if (chosen === 'failed' || chosen === 'needs-repeat') {
    message += ` ${host.t('To run it again with other conditions, use "{0}".', host.t('Retry this experiment'))}`;
  }
  // Ctrl+Z 는 README 가 열린 노트일 때만 닿는다.
  const active = ctx.activePath();
  if (!samePath(active, readmePath)) {
    const sameExperiment = active !== undefined && getExperimentDir(active) === labnoteDir;
    const fromView = experimentDir !== undefined && !sameExperiment;
    if (!fromView) message += ` ${host.t("Changed {0}'s README, not this note.", folderName)}`;
    if (current) {
      message += ` ${
        fromView
          ? host.t('To undo, right-click this experiment in the workflow view again and pick {0}.', current)
          : host.t('To undo, run "{0}" again and pick {1}.', host.t('Change experiment status'), current)
      }`;
      if (cleared) message += ` ${host.t('Turn the discussion flag back on with "{0}".', host.t('Toggle discussion flag'))}`;
    }
  }
  if (chosen === 'needs-review') {
    // 'none' 에는 "Setup research automation" 안내를 붙이지 않는다(앱에 아직 그 명령이 없다).
    if ((await issueAutomationState(host)) === 'no-git') {
      message += ` ${host.t(
        'This vault is not a git repository yet, so no review issue will open. Finish the repository setup in {0} first.',
        SETUP_DOC_PATH,
      )}`;
    }
  }
  host.notify('info', message);
}

/** 실험 README 의 `discuss` 표시를 켜거나 끈다. */
export async function toggleDiscussionFlag(ctx: CommandContext, experimentDir?: string): Promise<void> {
  const { host } = ctx;
  const stamp = readmeStamp(ctx.settings);
  const labnoteDir = experimentDir ?? resolveLabnoteDir(host, ctx.activePath());
  if (!labnoteDir) return;

  const readmePath = posix.join(labnoteDir, README);
  if (!(await host.fs.exists(readmePath))) {
    host.notify('warn', host.t('This experiment has no README.labnote.md.'));
    return;
  }

  const parsed = await readNoteForFrontMatterEdit(host, readmePath);
  if (!parsed) return;

  const next = !isDiscussFlagged(parsed.frontMatter);
  // 플러그인: writeNoteThroughVault(app, host, readmePath, stamp(setFrontMatterKeys(parsed.text, {...})))
  await processNote(host.fs, readmePath, (text) =>
    stamp(setFrontMatterKeys(text, { [DISCUSS_FLAG_KEY]: next ? true : undefined })),
  );

  const state = await issueAutomationState(host);
  let message: string;
  if (next) {
    message =
      state === 'ready'
        ? host.t('Flagged for discussion. An issue opens on the next push.')
        : state === 'no-git'
          ? host.t(
              'Flagged for discussion. This vault is not a git repository yet, so no issue will open. Finish the repository setup in {0} first.',
              SETUP_DOC_PATH,
            )
          : // 플러그인 키: 'Flagged for discussion. To open it as an issue, run "Setup research automation" first.'
            overrideOr('discussFlag.flagged');
  } else {
    message =
      state === 'ready'
        ? host.t('Discussion flag cleared. Any issue already opened stays open.')
        : host.t('Discussion flag cleared.');
    const spots = await experimentMarkerSpots(host.fs, labnoteDir);
    if (spots.length > 0) {
      message += ` ${host.t(
        '{0} @issue marker(s) remain, so the experiment stays under "{1}": {2}.',
        String(spots.length),
        host.t('Something to discuss'),
        formatMarkerSpots(spots, host.t),
      )}`;
    }
  }
  if (!samePath(ctx.activePath(), readmePath)) {
    message += ` ${host.t("Changed {0}'s README, not this note.", posix.basename(labnoteDir))}`;
  }
  host.notify('info', message);
}

/** registerAll.ts 가 등록하는 실험 명령. id 와 이름은 플러그인 그대로. */
export const experimentCommands: Command[] = [
  { id: 'create-experiment', nameKey: 'Create experiment', run: (ctx) => createExperiment(ctx) },
  { id: 'change-experiment-status', nameKey: 'Change experiment status', run: (ctx) => changeExperimentStatus(ctx) },
  { id: 'retry-experiment', nameKey: 'Retry this experiment', run: (ctx) => retryFromActive(ctx) },
  { id: 'toggle-discussion-flag', nameKey: 'Toggle discussion flag', run: (ctx) => toggleDiscussionFlag(ctx) },
];
