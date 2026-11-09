// Ported from app/vendor/labnoteo/src/llm/commands.ts:366-486 sha256:b4ab1d6e9c256aee
// Ported from app/vendor/labnoteo/src/llm/commands.ts:740-749 sha256:f38a6737dcd7e8bd
// labnoteO 0.140.2, Apache-2.0.
// Changes: LabnotePlugin → AiEnv (ai/aiEnv.ts); plugin.host.editTarget() → env.ctx.host.editTarget() (the app EditTarget over the open editor); plugin.t → env.host.t (coreT, the plugin keys); the Notices → env.host.notify ('info' for "Open a note…", "This workflow note has no unit operation yet…" (an 8 s Notice) and "The cursor was above…"); getSeoulDateString comes from core (@labnoteo/core/lib/dateUtils); 'Configure an AI provider in settings first.' (createLlmProvider(plugin.settings) is null) → env.provider is null → notify('info', overrideOr('ai.configureFirst')) (D21), before any question; noteRef(plugin, path) → noteRef(env, path), whose rename subscription is released on every early return (a closed pick, a declined confirm, no reply) and otherwise by deliverToNote; complete returns a ChatResult, so its content is read off it; complete, deliverToNote, writeMethodDraft and unitOpContext come from port/aiCommon.ts (Task 31). The prompts, the 6000 / 2000 / 4000 caps and the callout header are the vendor's; the free-note user message is joined with '\n' instead of one template (src/__tests__/escapes.test.ts reads "Context:" followed by an escape as a drive path); the string is the same; for the same reason the unit operation's heading is read into a constant before the template. toNoteCallout (vendor :744) is copied here as well, exported for the summary commands (Task 33).
import {
  cleanMethodDraft,
  extractMethodBody,
  findUnitOpMethodAt,
  listUnitOpBlocks,
  listUnitOpMethods,
  neutralizeIssueMarkers,
  type UnitOpMethodLocation,
} from '@labnoteo/core';
import { getSeoulDateString } from '@labnoteo/core/lib/dateUtils';
import { diagnoseWorkflowPath } from '@labnoteo/core/lib/workflowStructure';
import type { AiEnv } from '../../ai/aiEnv';
import { overrideOr } from '../i18n';
import { complete, deliverToNote, noteRef, replyLanguageInstruction, unitOpContext, writeMethodDraft } from './aiCommon';

/**
 * Draft a Method section. Inside a unit operation the draft replaces that unit
 * operation's `#### Method` body (asking first when the researcher already
 * wrote one); anywhere else it goes in as a block after the cursor's line.
 */
export async function draftMethodCommand(env: AiEnv): Promise<void> {
  const target = env.ctx.host.editTarget();
  if (!target) {
    env.host.notify('info', env.host.t('Open a note to insert into.'));
    return;
  }
  // Before any question: without a provider the answers would go nowhere (#399).
  if (!env.provider) {
    // Plugin: 'Configure an AI provider in settings first.'
    env.host.notify('info', overrideOr('ai.configureFirst'));
    return;
  }
  const note = noteRef(env, target.path);
  // deliverToNote releases the reference once it has the reply; every earlier return releases it here.
  let handedOver = false;
  try {
    const text = await target.getText();
    if (diagnoseWorkflowPath(target.path).kind === 'ok' && listUnitOpBlocks(text).length === 0) {
      env.host.notify(
        'info',
        env.host.t('This workflow note has no unit operation yet. Insert one first, then draft its Method.')
      );
      return;
    }
    let loc: UnitOpMethodLocation | null = target.getCursorOffset
      ? findUnitOpMethodAt(text, await target.getCursorOffset())
      : null;
    if (!loc) {
      // Outside a unit operation of a note that has some: ask which Method (#164).
      const methods = listUnitOpMethods(text);
      if (methods.length > 0) {
        const chosen = await env.host.pick(
          methods.map(m => ({
            label: m.unitOpHeading.replace(/^###\s+/, ''),
            detail: m.isPlaceholder ? undefined : env.host.t('Has a Method already'),
            value: m,
          })),
          { placeholder: env.host.t("Which unit operation's Method should the draft go in?") }
        );
        if (!chosen) return;
        loc = chosen;
      }
    }

    if (loc && !loc.isPlaceholder) {
      // Ask before the request, not after: the reply can take minutes.
      const ok = await env.host.confirm(
        env.host.t('This Method section already has content. Replace it with the AI draft?'),
        { confirmLabel: env.host.t('Replace'), destructive: true }
      );
      if (!ok) return;
    }

    if (!loc) {
      const out = await complete(env, [
        {
          role: 'system',
          content:
            'You write concise, reproducible **Method** subsections for a scientific lab notebook. Output only the Method body as GitHub-flavored Markdown: no front matter, no headings, no preamble or code fences. ' +
            replyLanguageInstruction(),
        },
        { role: 'user', content: ['Draft a Method subsection for this note.', '', 'Context:', text.slice(0, 6000)].join('\n') },
      ]);
      const cleaned = out ? cleanMethodDraft(out.content) : '';
      // No Method section to hold it: the whole draft stays in the AI callout,
      // so result summaries do not read it as the researcher's (#392).
      const draft = cleaned ? toNoteCallout(cleaned, draftHeader(env)) : '';
      if (draft) {
        handedOver = true;
        await deliverToNote(
          env,
          note,
          draft,
          async t => {
            if (await writeMethodDraft(env, t, null, draft)) {
              env.host.notify('info', env.host.t('The cursor was above the note body, so the draft went to the end of the note.'));
            }
          },
          'Inserted the Method draft into {0}.'
        );
      }
      return;
    }

    const chosenLoc = loc;
    const heading = chosenLoc.unitOpHeading.replace(/^###\s+/, '');
    const out = await complete(env, [
      {
        role: 'system',
        content:
          'You write the body of the **Method** subsection of one unit operation in a scientific lab notebook: concise, reproducible steps. Output only that body as GitHub-flavored Markdown (for example a numbered list) — no headings, no other subsections, no preamble or code fences. ' +
          replyLanguageInstruction(),
      },
      {
        role: 'user',
        content: `Draft the Method body for the unit operation "${heading}".\n\n${unitOpContext(text, chosenLoc)}`,
      },
    ]);
    if (!out) return;
    const body = withDraftHeader(env, extractMethodBody(out.content) || out.content.trim());
    handedOver = true;
    await deliverToNote(
      env,
      note,
      body,
      async t => {
        await writeMethodDraft(env, t, chosenLoc, body);
      },
      'Inserted the Method draft into {0}.'
    );
  } finally {
    if (!handedOver) note.release();
  }
}

/** The title of the callout over an AI Method draft. */
export function draftHeader(env: AiEnv): string {
  return env.host.t(
    'AI draft ({0}, {1}) — review it, then delete this line',
    env.settings().llmModel || env.settings().llmProvider,
    getSeoulDateString()
  );
}

/**
 * `draft` under a one-line `> [!note] AI draft (model, date)` callout (#280),
 * so a Method the model wrote reads as unchecked until someone removes it.
 * Summaries and the worksheet leave the line out.
 */
export function withDraftHeader(env: AiEnv, draft: string): string {
  return `> [!note] ${draftHeader(env)}\n\n${neutralizeIssueMarkers(draft)}`;
}

/**
 * `body` as a `> [!note] header` callout (#150), so an AI summary reads as
 * one block that is clearly the model's and not the researcher's.
 */
export function toNoteCallout(body: string, header: string): string {
  const lines = neutralizeIssueMarkers(body.trim())
    .split(/\r?\n/)
    .map(l => (l.trim() === '' ? '>' : `> ${l}`));
  return [`> [!note] ${header}`, ...lines].join('\n');
}
