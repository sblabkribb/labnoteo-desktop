// Ported from app/vendor/labnoteo/src/llm/commands.ts:489-738 sha256:c8e247b64ea12ee8
// labnoteO 0.140.2, Apache-2.0.
// Changes: LabnotePlugin → AiEnv (ai/aiEnv.ts); plugin.host.editTarget() → env.ctx.host.editTarget() (the app EditTarget over the open editor, which refuses while the view is composing); plugin.t → env.host.t (coreT, the plugin keys); the Notices → env.host.notify('info') (the 8 s ones included); plugin.markUserEdit is removed (the editor stamps on user edits); getSeoulDateString comes from core; plugin.settings → env.settings(); complete, deliverToNote, insertBlock, noteRef, replyLanguageInstruction and SUMMARY_REFERENCE_INSTRUCTION come from port/aiCommon.ts (Task 31) and toNoteCallout from port/aiDraftMethod.ts (vendor :744, re-exported here); complete returns a ChatResult, so its content is read off it, and 'Configure an AI provider in settings first.' is complete's overrideOr('ai.configureFirst') (D21); noteRef(plugin, path) → noteRef(env, path), whose rename subscription is released on every early return and otherwise by deliverToNote. summaryTitles takes the English key and its translation as two arguments, so each host.t call names its key in writing (koCoverage). readNoteNow: the open editor's buffer (openNote(path) in labnote/openNotes.ts, once it has read the file) before host.fs.read (undefined when that fails), instead of Obsidian's markdown leaves and vault.cachedRead. experimentNotes: host.fs.list(dir) filtered by parseWorkflowFileName and sorted, then ordered by workflowChecklistOrder, instead of vault.getMarkdownFiles; a folder that cannot be listed has no notes. The prompts, the 6000-char cap, the 10000 experiment budget and the 2000-char README memo are the vendor's; the user messages are joined with '\n' instead of one template (src/__tests__/escapes.test.ts reads "results:" or "workflow:" followed by an escape as a drive path); the strings are the same.
import {
  dropEchoedLines,
  extractResultSections,
  findAiCalloutInSection,
  hasRecordedResults,
  locateSummary,
  planSectionAppend,
  sectionText,
  shareBudget,
  stripAiCallouts,
  stripFrontMatter,
  stripIssueMarkers,
  stripTemplatePlaceholders,
  type EditTarget,
} from '@labnoteo/core';
import { getSeoulDateString } from '@labnoteo/core/lib/dateUtils';
import {
  diagnoseWorkflowPath,
  parseWorkflowFileName,
  workflowChecklistOrder,
  workflowLabelFor,
} from '@labnoteo/core/lib/workflowStructure';
import type { AiEnv } from '../../ai/aiEnv';
import { openNote } from '../openNotes';
import { complete, deliverToNote, insertBlock, noteRef, replyLanguageInstruction, SUMMARY_REFERENCE_INSTRUCTION } from './aiCommon';
import { toNoteCallout } from './aiDraftMethod';

export { toNoteCallout };

/** Where a workflow note's summary goes (#279). */
const CONCLUSIONS_HEADING = 'Conclusions and Discussion';
/** Where an experiment's summary goes in its README (#306). */
const README_SUMMARY_HEADING = 'Summary and Discussion';
/** Characters of results sent for a whole experiment, shared among its notes (#306). */
const EXPERIMENT_RESULTS_BUDGET = 10000;

/** The callout titles an earlier run of a summary wrote, in English (`key`) and in the UI language (`translated`). */
function summaryTitles(key: string, translated: string): string[] {
  const before = (title: string) => title.split(' (')[0].trim();
  return [...new Set([before(key), before(translated)])];
}

/**
 * Put a summary callout at the end of the section `heading` (the note's end
 * without one), over the summary an earlier run left there when `replace`.
 * Reads the note now, after the reply arrived.
 */
async function writeSummary(
  env: AiEnv,
  target: EditTarget,
  heading: string,
  titles: readonly string[],
  block: string
): Promise<void> {
  const text = await target.getText();
  const place = locateSummary(text, heading, titles);
  const earlier = findAiCalloutInSection(text, heading, titles);
  // The cursor is left alone: the user kept writing while the model ran, and
  // moving it put their next words into the callout (#357).
  if (earlier) {
    await target.replaceRange(earlier.start, earlier.end, block);
  } else {
    const plan = planSectionAppend(text, heading, block, titles) ?? {
      offset: text.length,
      text: `${text.endsWith('\n') ? '\n' : '\n\n'}${block}\n`,
    };
    await target.replaceRange(plan.offset, plan.offset, plan.text);
  }
  // The heading was renamed or removed (#319): say where the summary went.
  if (place.kind === 'callout') {
    env.host.notify(
      'info',
      env.host.t(
        'There is no "{0}" section, so the summary replaced the earlier one under "{1}".',
        heading,
        place.heading || env.host.t('(top of the note)')
      )
    );
  } else if (place.kind === 'end') {
    env.host.notify('info', env.host.t('There is no "{0}" section, so the summary went at the end of the note.', heading));
  }
}

/** Ask before a summary replaces the one an earlier run wrote in `heading` (or where it was found instead, #319). */
async function confirmReplaceSummary(env: AiEnv, text: string, heading: string, titles: readonly string[]): Promise<boolean> {
  if (!findAiCalloutInSection(text, heading, titles)) return true;
  const place = locateSummary(text, heading, titles);
  const where = place.kind === 'callout' ? place.heading || env.host.t('(top of the note)') : heading;
  // A note typed inside the callout goes with it (#498).
  const message = `${env.host.t('"{0}" already has an AI summary. Replace it with a new one?', where)} ${env.host.t(
    'What you typed inside the callout is replaced too; keep notes you want outside it.'
  )}`;
  return env.host.confirm(message, {
    confirmLabel: env.host.t('Replace'),
    destructive: true,
  });
}

/** Whether `path` is an experiment README, which has a summary command of its own (#306). */
export function isExperimentReadme(path: string): boolean {
  return diagnoseWorkflowPath(path).kind === 'readme';
}

/** The model named in a summary's callout title. */
function modelName(env: AiEnv): string {
  return env.settings().llmModel || env.settings().llmProvider;
}

/**
 * Summarize the results of the active note (#279). In a workflow note only
 * its result sections are sent, and the summary goes at the end of
 * `Conclusions and Discussion`, replacing the one an earlier run put there;
 * in any other note the whole note is sent and the summary goes after the
 * cursor's line.
 */
export async function summarizeResultsCommand(env: AiEnv): Promise<void> {
  const target = env.ctx.host.editTarget();
  if (!target) {
    env.host.notify('info', env.host.t('Open a note to insert into.'));
    return;
  }
  if (isExperimentReadme(target.path)) {
    env.host.notify(
      'info',
      env.host.t('In an experiment README, run "{0}".', env.host.t('AI: Summarize experiment results'))
    );
    return;
  }
  const note = noteRef(env, target.path);
  // deliverToNote releases the reference once it has the reply; every earlier return releases it here.
  let handedOver = false;
  try {
    // Read from the SAME target we insert into (previously this read the active
    // MarkdownView, which could differ from the insert target when a sidebar had
    // focus — reading note A while writing to note B).
    const text = await target.getText();
    if (!text.trim()) {
      env.host.notify('info', env.host.t('Nothing to summarize.'));
      return;
    }
    // A note holding only the template used to be summarized into invented
    // measurements (#257), so stop while the result sections are still empty.
    if (!hasRecordedResults(text)) {
      env.host.notify(
        'info',
        env.host.t(
          'No results to summarize yet. Write them under a unit operation\'s "Results & Discussions", "QC Metrics" or "Discussion", a software unit operation\'s "Output", or "Conclusions and Discussion", and run this again.'
        )
      );
      return;
    }
    const workflow = diagnoseWorkflowPath(target.path).kind === 'ok';
    const titles = summaryTitles(
      'AI workflow results summary ({0}, {1})',
      env.host.t('AI workflow results summary ({0}, {1})')
    );
    if (workflow && !(await confirmReplaceSummary(env, text, CONCLUSIONS_HEADING, titles))) return;
    const results = workflow
      ? extractResultSections(text)
      : stripIssueMarkers(stripTemplatePlaceholders(stripAiCallouts(stripFrontMatter(text))));
    const out = await complete(env, [
      {
        role: 'system',
        content:
          'You summarize experimental Results for a lab notebook as 3–6 concise Markdown bullet points. No preamble, no code fences. ' +
          'Use only measurements and observations written in the note; never invent a number, a result or a conclusion that is not there. ' +
          `${SUMMARY_REFERENCE_INSTRUCTION} ` +
          replyLanguageInstruction(undefined, { keepSampleIds: false }),
      },
      {
        role: 'user',
        content: ['Summarize these results:', '', results.slice(0, 6000)].join('\n'),
      },
    ]);
    if (!out) return;
    const model = modelName(env);
    if (!workflow) {
      const block = toNoteCallout(out.content, env.host.t('AI summary ({0}, {1})', model, getSeoulDateString()));
      handedOver = true;
      await deliverToNote(
        env,
        note,
        block,
        async t => {
          await insertBlock(env, t, block, { reveal: false });
        },
        'Inserted the summary into {0}.'
      );
      return;
    }
    const block = toNoteCallout(
      out.content,
      env.host.t('AI workflow results summary ({0}, {1})', model, getSeoulDateString())
    );
    handedOver = true;
    await deliverToNote(
      env,
      note,
      block,
      t => writeSummary(env, t, CONCLUSIONS_HEADING, titles, block),
      'Inserted the summary into {0}.'
    );
  } finally {
    if (!handedOver) note.release();
  }
}

/** A note's text as the researcher sees it: from its open editor, else from the vault. */
async function readNoteNow(env: AiEnv, path: string): Promise<string | undefined> {
  const handle = openNote(path);
  const view = handle?.view();
  // rawText() is undefined until the editor has read the file: its buffer is not the note yet.
  if (handle && view && handle.rawText() !== undefined) return view.state.doc.toString();
  try {
    return await env.host.fs.read(path);
  } catch {
    return undefined;
  }
}

/**
 * The workflow notes of the experiment in `dir`: in the README checklist's
 * order, then the ones it does not list, by number.
 */
async function experimentNotes(env: AiEnv, dir: string, readme: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await env.host.fs.list(dir);
  } catch {
    return [];
  }
  const names = entries.filter(name => parseWorkflowFileName(name)).sort();
  const listed = workflowChecklistOrder(readme, names, dir);
  return [...listed, ...names.filter(n => !listed.includes(n))];
}

/**
 * Summarize a whole experiment from its README (#306): the result sections of
 * every workflow note, in checklist order and within a shared budget, plus
 * the README's own `Summary and Discussion` notes. The summary goes at the
 * end of that section, replacing the one an earlier run put there.
 */
export async function summarizeExperimentCommand(env: AiEnv): Promise<void> {
  const target = env.ctx.host.editTarget();
  if (!target || !isExperimentReadme(target.path)) {
    env.host.notify('info', env.host.t('Open an experiment README first.'));
    return;
  }
  const note = noteRef(env, target.path);
  let handedOver = false;
  try {
    const readme = await target.getText();
    const dir = target.path.slice(0, target.path.lastIndexOf('/'));
    const collected: Array<{ label: string; results: string }> = [];
    for (const name of await experimentNotes(env, dir, readme)) {
      const text = await readNoteNow(env, `${dir}/${name}`);
      const results = text === undefined ? '' : extractResultSections(text);
      if (results) collected.push({ label: workflowLabelFor(name, text), results });
    }
    if (collected.length === 0) {
      env.host.notify(
        'info',
        env.host.t('No results are written in the workflow notes of this experiment yet, so there is nothing to summarize.')
      );
      return;
    }
    const titles = summaryTitles(
      'AI experiment results summary ({0}, {1})',
      env.host.t('AI experiment results summary ({0}, {1})')
    );
    if (!(await confirmReplaceSummary(env, readme, README_SUMMARY_HEADING, titles))) return;
    const memo = stripIssueMarkers(stripAiCallouts(sectionText(readme, README_SUMMARY_HEADING, titles) ?? ''))
      .trim()
      .slice(0, 2000);
    const shares = shareBudget(
      collected.map(c => c.results.length),
      EXPERIMENT_RESULTS_BUDGET
    );
    const body = collected.map((c, i) => `## ${c.label}\n${c.results.slice(0, shares[i])}`).join('\n\n');
    const notes = memo ? `<researcher-notes>\n${memo}\n</researcher-notes>\n\n` : '';
    const reply = await complete(env, [
      {
        role: 'system',
        content:
          'You summarize a whole experiment for its lab notebook overview from the results of its workflows, given in order: ' +
          '3–8 concise Markdown bullet points on what was found and how the workflows connect, then one line on what is still open. ' +
          'No preamble, no code fences. Use only what is written; never invent a number, a result or a conclusion. ' +
          'The researcher\'s own notes, inside <researcher-notes>, are context only: they stay in the note as they are, so do not copy, restate or rephrase them in the answer. ' +
          `${SUMMARY_REFERENCE_INSTRUCTION} ` +
          replyLanguageInstruction(undefined, { keepSampleIds: false }),
      },
      {
        role: 'user',
        content: notes + ['Results of each workflow:', '', body].join('\n'),
      },
    ]);
    if (!reply) return;
    const out = memo ? dropEchoedLines(reply.content, memo) : reply.content;
    const header = env.host.t('AI experiment results summary ({0}, {1})', modelName(env), getSeoulDateString());
    const block = toNoteCallout(out, header);
    handedOver = true;
    await deliverToNote(
      env,
      note,
      block,
      t => writeSummary(env, t, README_SUMMARY_HEADING, titles, block),
      env.host.t('Summarized the results of {0} workflow note(s) into {1}.', String(collected.length), '{0}')
    );
  } finally {
    if (!handedOver) note.release();
  }
}
