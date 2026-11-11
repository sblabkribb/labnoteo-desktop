// Ported from app/vendor/labnoteo/src/llm/commands.ts:69-364 sha256:d02d476a21fa9394
// labnoteO 0.140.2, Apache-2.0.
// Changes: LabnotePlugin → AiEnv (ai/aiEnv.ts); plugin.t → env.host.t (coreT, the plugin keys); getObsidianLanguage() → getLang() (env.lang() in toolContext). toolContext: fs is env.sampleEnv().fs (safeRegistryFs over the trashing fs) wrapped so the paths a tool read are remembered; globalSampleFolder is env.sampleEnv().globalFolder() (normalised); customTypes and sortUnitOpToc come from env.settings(); findSampleUsages → the ported sampleUsages(env.sampleEnv(), …) (port/sampleQuery.ts); writeNote (vendor plugin.writeNoteStamped) → a file that exists, or that a tool read before, goes through processNote(env.host.fs, path, () => content) (compare-and-swap for a closed note; NoteBusyError for an open note that is saving or composing; notFound or NoteGoneError for a note deleted meanwhile, which runTool reports as a failed call and which is never recreated), a README's content gets readmeStamp(settings), and only a file that does not exist is created with host.fs.write; the vendor's stamp of a workflow note's last_updated_date is left to the editor, which stamps on user edits (as in the SP5 ports); toolContext takes an optional beforeWrite hook (the agent passes guard.check, D11). complete takes env.provider (built once by createAiEnv) instead of createLlmProvider(plugin.settings) and returns the ChatResult with its content trimmed, not the string; 'Configure an AI provider in settings first.' → notify('info', overrideOr('ai.configureFirst')) (D21); the persistent 'Contacting {0}…' Notice → withProgress(host.t('Contacting {0}…', provider.label), …, { cancellable: true }) whose signal goes to provider.chat (Cancel ends the request in Rust); the 10 s notices → host.notify('warn'); a cancelled request (describeLlmError gives '') shows nothing. insertBlock, writeMethodDraft and deliverToNote write through the app EditTarget (labnote/editTarget.ts), which refuses while the view is composing; plugin.markUserEdit is removed (the editor stamps on user edits). NoteRef: Obsidian's TFile rename tracking → a path that follows entryEvents renames until release(); noteRef takes env and the path. deliverToNote: when the write is refused with NoteBusyError while the view is composing, it waits for compositionend (at most COMPOSITION_WAIT_MS = 5 s) and tries once more; still refused (or busy for another reason) → the answer dialog; it releases the NoteRef when the reply is delivered or the dialog closes. aiAnswerModal(app, …) → aiAnswerDialog (port/aiAnswerDialog.tsx), not awaited. Notices of writeMethodDraft → host.notify('info'). toolRunNotice and failureReasons take env; the failure texts are the vendor's, through host.t. unitOpContext joins the same parts with '\n' instead of one template (src/__tests__/escapes.test.ts reads "description:" followed by an escape as a drive path); the result is the same string. Every helper is exported for the command ports (Tasks 32-35). toolContext's opts also take scope, allowedFolders, experiments and searchIn (feat/ai-context, spec §9) and return them on the context as a ScopedToolContext; failureReasonText words the scope codes (outOfScope, scopeRequired, noExperiment, unknownExperiment, ambiguousExperiment) through scopeErrorText, in the app catalog. complete takes an optional opts { contextWindow } (feat/ai-context) passed on to provider.chat; without it chat is called as before. replyLanguageInstruction adds KOREAN_TERMS_INSTRUCTION (Workflow / Unit Operation stay in English) when the language is Korean.
import {
  findUnitOpMethodByIndex,
  neutralizeIssueMarkers,
  planBlockInsert,
  replaceSectionBodyAt,
  minimalReplacement,
  type EditTarget,
  type ToolContext,
  type UnitOpMethodLocation,
} from '@labnoteo/core';
import { caretIn } from '@labnoteo/core/lib/caret';
import type { EditorView } from '@codemirror/view';
import type { AiEnv } from '../../ai/aiEnv';
import { getLang } from '../../i18n/lang';
import { withProgress } from '../../integrations/progressStore';
import { entryEvents } from '../commands/entryEvents';
import { readmeStamp } from '../commands/stamp';
import { overrideOr } from '../i18n';
import { NoteBusyError, processNote } from '../openNotes';
import { pathKey } from '../paths';
import { aiAnswerDialog } from './aiAnswerDialog';
import type { AgentRun } from './llmAgent';
import { countToolOutcomes } from './llmAgent';
import { describeLlmError } from './llmError';
import type { ChatMessage, ChatResult } from './llmProvider';
import { sampleUsages } from './sampleQuery';
import { scopeErrorText } from '../context/appTools';
import type { ScopedToolContext } from '../context/contextTools';

const README_RE = /(?:^|\/)README\.labnote\.md$/i;

/**
 * Tool context for AI-driven edits.
 *
 * `writeNote` matters here for the same reason it does on the MCP path: the AI
 * edits notes the user is plausibly looking at, and an adapter-level write
 * would be overwritten by the open editor's next flush.
 */
export function toolContext(
  env: AiEnv,
  opts: { beforeWrite?: () => Promise<void> } & Pick<ScopedToolContext, 'scope' | 'allowedFolders' | 'experiments' | 'searchIn'> = {}
): ScopedToolContext {
  const samples = env.sampleEnv();
  const inner = samples.fs;
  // Paths a tool read: one that is gone by the time of its write was deleted meanwhile and is not recreated.
  const read = new Set<string>();
  const fs = {
    ...inner,
    async read(path: string) {
      const text = await inner.read(path);
      read.add(pathKey(path));
      return text;
    },
  };
  return {
    fs,
    workspaceRoot: '.',
    globalSampleFolder: samples.globalFolder(),
    customTypes: env.settings().customSampleTypes,
    locale: env.lang(),
    sortUnitOpToc: env.settings().autoSyncUnitOpToc,
    async writeNote(path, content) {
      await opts.beforeWrite?.();
      const text = README_RE.test(path) ? readmeStamp(env.settings())(content) : content;
      if (read.has(pathKey(path)) || (await env.host.fs.exists(path))) {
        await processNote(env.host.fs, path, () => text);
        return;
      }
      await env.host.fs.write(path, text);
    },
    findSampleUsages: (folder, type, id) => sampleUsages(samples, folder, type, id),
    ...(opts.scope ? { scope: opts.scope } : {}),
    ...(opts.allowedFolders ? { allowedFolders: opts.allowedFolders } : {}),
    ...(opts.experiments ? { experiments: opts.experiments } : {}),
    ...(opts.searchIn ? { searchIn: opts.searchIn } : {}),
  };
}

/**
 * The app's term rule (2026-11-11): in Korean, "Workflow" and "Unit Operation" stay in English, as in the
 * Korean UI (labnote/i18n.ts koTerms). One sentence shared by every prompt whose answer may be Korean:
 * replyLanguageInstruction adds it for Korean; prompts without a language line (Ask agent, chat compaction,
 * the MCP prompts) add it as is.
 */
export const KOREAN_TERMS_INSTRUCTION =
  'When you write Korean, keep the terms "Workflow" and "Unit Operation" in English (never 워크플로, 단위 공정 or ' +
  '유닛 오퍼레이션; "UO" is fine where space is tight), with the Korean particle that fits the English word ' +
  '(Workflow를, Workflow가, Workflow로, Unit Operation을, Unit Operation이, Unit Operation으로); other words stay Korean.';

/**
 * The system-prompt line telling the model to write in Obsidian's UI
 * language (#237): the note itself may be in English while the researcher
 * reads Korean, and models otherwise answer in the language of the prompt.
 * A summary leaves `keepSampleIds` off (#527): "keep sample IDs as written"
 * had the model copy the `ID;alias` references the summary must not carry.
 */
export function replyLanguageInstruction(
  lang: string = getLang(),
  { keepSampleIds = true }: { keepSampleIds?: boolean } = {}
): string {
  const code = lang.split('-')[0].toLowerCase() || 'en';
  let name = code;
  try {
    name = new Intl.DisplayNames(['en'], { type: 'language' }).of(code) ?? code;
  } catch {
    // An unknown code stays as it is.
  }
  const kept = keepSampleIds ? 'sample IDs, units, numbers and quoted text' : 'units, numbers and quoted text';
  const line = `Write the answer in ${name}. Keep ${kept} exactly as they appear in the note.`;
  return code === 'ko' ? `${line} ${KOREAN_TERMS_INSTRUCTION}` : line;
}

/**
 * For the summaries (#318, #354): a sample reference or an `@issue` marker
 * copied into the summary would count as a usage of the sample or open an
 * issue, so the model names samples in words.
 */
export const SUMMARY_REFERENCE_INSTRUCTION =
  'Name a sample by its alias or ID in plain words; never copy a sample reference written as "ID;alias" or "@Type;ID;alias", and never write "@issue".';

/** The notice for an empty reply (#195), naming a thinking-only one as such. */
export function noAnswerMessage(env: AiEnv, thinkingOnly: boolean | undefined): string {
  return thinkingOnly
    ? env.host.t('The model gave no answer (it only thought). Try again or choose another model.')
    : env.host.t('The model gave no answer. Try again or choose another model.');
}

/**
 * The end notice of the assistant (#186): what changed, what was only read,
 * and what was denied or failed, so a denied write is not counted as done.
 */
export function toolRunNotice(env: AiEnv, executed: AgentRun['executed']): string {
  if (executed.length === 0) return env.host.t('The AI used no tools; nothing in the vault changed.');
  const c = countToolOutcomes(executed);
  const parts: string[] = [];
  if (c.changed > 0) parts.push(env.host.t('{0} change(s) made', String(c.changed)));
  if (c.read > 0) parts.push(env.host.t('{0} lookup(s)', String(c.read)));
  if (c.denied > 0) parts.push(env.host.t('{0} denied by you', String(c.denied)));
  if (c.failed > 0) parts.push(env.host.t('{0} failed', String(c.failed)));
  const summary = env.host.t('AI tool calls: {0}.', parts.join(', '));
  const why = failureReasons(env, executed);
  const text = why ? `${summary} ${why}` : summary;
  return c.changed > 0 ? text : `${text} ${env.host.t('Nothing in the vault changed.')}`;
}

/** Failures named in the end notice; the rest are counted. */
export const NAMED_FAILURES = 3;
/** Characters of a failure reason shown in the end notice. */
export const FAILURE_REASON_MAX = 80;

/**
 * A refusal the plugin knows a rule for, worded in the language of the
 * interface (#529). The English sentence the tool returned is for the model;
 * the researcher reading the notice gets this. Each `t` call is written out so
 * the i18n coverage test sees the key. Undefined for a code without a wording,
 * and for the argument-shape errors only the model reads.
 */
export function failureReasonText(env: AiEnv, code: string, params: readonly string[]): string | undefined {
  const [a = '', b = ''] = params;
  switch (code) {
    case 'sample_alias_separator':
      return env.host.t(
        'An alias cannot contain ";" or ":", which separate the ID, alias and description in a note. Use "-" or "/" instead (e.g. 1-10).'
      );
    case 'sample_alias_markdown':
      return env.host.t(
        'An alias cannot contain #, [[, ]], ](, *, _ or `, which Markdown reads as a tag, link, emphasis or code. Use "-" or "/" instead.'
      );
    case 'sample_desc_separator':
      return env.host.t('A description cannot contain ";", which ends the description in a note. Use "," instead.');
    case 'sample_type_unknown':
      return env.host.t('"{0}" is not one of the sample types ({1}). Add it in the Labnote settings first.', a, b);
    case 'sample_id_invalid':
      return env.host.t('"{0}" is not a {1} ID: it must read {1}-<number>.', a, b);
    case 'workflow_alias_hash':
      return env.host.t('A workflow alias cannot contain "#": links to its heading would break.');
    case 'workflow_alias_markdown':
      return env.host.t('A workflow alias cannot contain "*" or "_": the reading view shows part of it in italics.');
    case 'not_experiment_folder':
      return env.host.t('"{0}" is not in an experiment folder (labnote/###_Name).', a.split('/').pop() ?? a);
    case 'unit_op_readme':
      return env.host.t(
        'README.labnote.md is the experiment overview and holds no unit operations. Open one of its workflow notes (###_….labnote.md), or make one with "{0}".',
        env.host.t('Create workflow')
      );
    case 'not_workflow_note':
      return env.host.t(
        '"{0}" is not a workflow note: unit operations go into a ###_….labnote.md note directly in the experiment folder. Open one, or make one with "{1}".',
        a.split('/').pop() ?? a,
        env.host.t('Create workflow')
      );
    case 'section_not_found':
      return env.host.t('The note has no "{0}" section.', a);
    default:
      // The experiment-scope codes of the context tools, worded from the app catalog (not the vendor one).
      return scopeErrorText(code, params);
  }
}

/**
 * Why tool calls failed or were rejected (#281), as `tool (target) — reason`
 * for the first few, the target being the alias, ID, heading or note the call
 * named. A reason the plugin knows is worded in the user's language before it
 * is cut to length (#529). All of them go to the console, in English.
 */
export function failureReasons(env: AiEnv, executed: AgentRun['executed']): string {
  const failed = executed.filter(e => e.outcome === 'failed' || e.outcome === 'rejected');
  if (failed.length === 0) return '';
  for (const e of failed) console.warn('[labnoteo] AI tool call failed:', e.call.name, e.call.arguments, e.error);
  const named = failed.slice(0, NAMED_FAILURES).map(e => {
    const args = e.call.arguments as Record<string, unknown>;
    const pick = [args.alias, args.id, args.heading, args.documentPath].find(v => typeof v === 'string' && v.trim());
    const target = typeof pick === 'string' ? pick.split('/').pop() : undefined;
    const known = e.code ? failureReasonText(env, e.code, e.params ?? []) : undefined;
    const reason = (known ?? e.error ?? '').replace(/\s+/g, ' ').trim();
    const short = reason.length > FAILURE_REASON_MAX ? `${reason.slice(0, FAILURE_REASON_MAX - 1)}…` : reason;
    return `${e.call.name}${target ? ` (${target})` : ''}${short ? ` — ${short}` : ''}`;
  });
  const more = failed.length - named.length;
  const list = more > 0 ? `${named.join('; ')}; ${env.host.t('+{0} more', String(more))}` : named.join('; ');
  return env.host.t('Failed: {0}.', list);
}

/**
 * One model call behind the progress dialog. Undefined after a notice: no
 * provider, an error, an empty reply, or nothing at all when the user cancelled.
 */
export async function complete(
  env: AiEnv,
  messages: ChatMessage[],
  opts: { contextWindow?: number } = {}
): Promise<ChatResult | undefined> {
  const provider = env.provider;
  if (!provider) {
    // Plugin: 'Configure an AI provider in settings first.'
    env.host.notify('info', overrideOr('ai.configureFirst'));
    return undefined;
  }
  try {
    const result = await withProgress(
      env.host.t('Contacting {0}…', provider.label),
      p =>
        provider.chat(messages, {
          temperature: 0.2,
          signal: p.signal,
          ...(opts.contextWindow != null ? { contextWindow: opts.contextWindow } : {}),
        }),
      { cancellable: true }
    );
    const content = result.content.trim();
    if (!content) {
      env.host.notify('warn', noAnswerMessage(env, result.thinkingOnly));
      return undefined;
    }
    return { ...result, content };
  } catch (err) {
    const message = describeLlmError(err, env.settings(), env.t);
    if (message) {
      console.error('[labnoteo] AI request failed:', err);
      env.host.notify('warn', message);
    }
    return undefined;
  }
}

/**
 * Insert a model reply as its own block after the cursor's line, never
 * splitting the line (#48), then reveal it. Reads text and cursor now, after
 * the reply arrived, since the user may have kept typing meanwhile. True when
 * a cursor above the body sent the block to the end of the note. `reveal:
 * false` for replies that arrive while the user writes on, which must leave
 * the cursor where it is (#357, #420). `caret` overrides that live cursor for
 * a command whose own dialogs left the editor reporting the start of the note
 * (#544).
 */
export async function insertBlock(
  env: AiEnv,
  target: EditTarget,
  answer: string,
  { reveal = true, caret }: { reveal?: boolean; caret?: number } = {}
): Promise<boolean> {
  void env;
  // Whatever the model wrote, nothing it inserts opens an issue (#354).
  const block = neutralizeIssueMarkers(answer);
  let atEnd = false;
  if (!target.getCursorOffset && caret === undefined) {
    await target.insertAtCursor(`\n${block}\n`);
  } else {
    const text = await target.getText();
    const at = caret === undefined ? await target.getCursorOffset!() : caretIn(caret, text);
    const plan = planBlockInsert(text, at, block);
    await target.replaceRange(plan.offset, plan.offset, plan.text);
    if (reveal) await target.revealOffset?.(plan.offset + plan.text.length);
    atEnd = plan.atEnd === true;
  }
  return atEnd;
}

/** A note followed by reference, so a rename does not lose track of it (#260). */
export interface NoteRef {
  readonly path: string;
  /** Stop following renames. Safe to call more than once. */
  release(): void;
}

/**
 * The note a command starts from. Its `path` follows the app's renames
 * (entryEvents) while the command runs, so a reply still goes in when the
 * note was renamed while the model was writing (#260).
 */
export function noteRef(env: AiEnv, path: string): NoteRef {
  void env;
  let current = path;
  const off = entryEvents.subscribe(e => {
    if (e.kind !== 'renamed') return;
    const key = pathKey(current);
    const moved = e.files.find(f => pathKey(f.from) === key);
    if (moved) current = moved.to;
  });
  return {
    get path() {
      return current;
    },
    release: off,
  };
}

/** How long a reply waits for a Hangul composition to end before it goes to the answer dialog. */
export const COMPOSITION_WAIT_MS = 5000;

/** True once the view stops composing (after a compositionend), false after `ms`. */
function compositionEnded(view: EditorView, ms: number): Promise<boolean> {
  return new Promise(resolve => {
    const dom = view.contentDOM;
    let done = false;
    const finish = (ended: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      dom.removeEventListener('compositionend', onEnd);
      resolve(ended);
    };
    // CodeMirror clears its composing state in its own compositionend handler: look once that ran.
    const onEnd = () => setTimeout(() => (view.composing ? undefined : finish(true)), 0);
    const timer = setTimeout(() => finish(!view.composing), ms);
    dom.addEventListener('compositionend', onEnd);
  });
}

/**
 * Write a reply into the note the command started from (#112, the #77 rule).
 * The tab's editor may show another note by the time the reply arrives, so it
 * goes in directly only while that note is still the edit target; otherwise
 * it opens in the answer dialog, whose "Insert into note" checks again. A
 * reply that arrives mid-syllable waits for the composition to end first.
 */
export async function deliverToNote(
  env: AiEnv,
  note: NoteRef,
  content: string,
  write: (target: EditTarget) => Promise<void>,
  doneMessage: string
): Promise<void> {
  const writeIfOpen = async (): Promise<boolean> => {
    const current = env.host.editTarget();
    if (current?.path !== note.path) return false;
    await write(current);
    env.host.notify('info', env.t(doneMessage, note.path.split('/').pop() ?? note.path));
    return true;
  };
  /** True when written; false when not open or still refused (busy, composing). */
  const tryWrite = async (): Promise<boolean> => {
    try {
      return await writeIfOpen();
    } catch (err) {
      if (!(err instanceof NoteBusyError)) throw err;
      const view = env.ctx.activeView();
      if (!view?.composing || !(await compositionEnded(view, COMPOSITION_WAIT_MS))) return false;
      try {
        return await writeIfOpen();
      } catch (again) {
        if (again instanceof NoteBusyError) return false;
        throw again;
      }
    }
  };
  let delivered = false;
  try {
    delivered = await tryWrite();
  } finally {
    if (delivered) note.release();
  }
  if (delivered) return;
  void aiAnswerDialog({
    content,
    sourcePath: note.path,
    onInsert: async () => {
      if (await writeIfOpen()) return true;
      env.host.notify('info', env.host.t('That note is no longer open. Copy the answer instead.'));
      return false;
    },
  }).finally(() => note.release());
}

/**
 * Put a Method draft in: over the unit operation's `#### Method` body when
 * the command started inside one (`loc`), else as a block after the cursor.
 * True when the block went to the end of the note instead (#392).
 */
export async function writeMethodDraft(
  env: AiEnv,
  target: EditTarget,
  loc: UnitOpMethodLocation | null,
  body: string
): Promise<boolean> {
  // The draft takes long enough to write on meanwhile, so the cursor stays put (#420).
  if (!loc) return insertBlock(env, target, body, { reveal: false });
  const latest = await target.getText();
  const again = findUnitOpMethodByIndex(latest, loc.unitOpIndex, loc.unitOpHeading);
  if (!again) {
    env.host.notify(
      'info',
      env.host.t('The unit operation changed while the AI was writing, so the draft was inserted after the cursor line instead.')
    );
    await insertBlock(env, target, body, { reveal: false });
    return false;
  }
  const edit = minimalReplacement(latest, replaceSectionBodyAt(latest, again.methodLine, body).md);
  if (edit) await target.replaceRange(edit.start, edit.end, edit.text);
  return false;
}

/** The model context for one unit operation: the note's head plus that block. */
export function unitOpContext(text: string, loc: UnitOpMethodLocation): string {
  const lines = text.split('\n');
  const firstUnitOp = lines.findIndex(l => /^###\s+\[/.test(l));
  const head = lines.slice(0, firstUnitOp === -1 ? 40 : Math.min(firstUnitOp, 40)).join('\n');
  const block = lines.slice(loc.unitOpStartLine, loc.unitOpEndLine).join('\n');
  // The vendor's template text, joined so the escapes guard does not read the colon and newline as a drive path.
  return ['Note front matter and workflow description:', head.slice(0, 2000), '', 'Unit operation:', block.slice(0, 4000)].join('\n');
}
