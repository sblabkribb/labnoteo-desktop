// "bfworkflow: Create notes from a design" (SP6 Task 40): pick a design, take the notes bfworkflow already saved
// on it or generate new ones over SSE, and write one .labnote.md per workflow into an experiment. Written fresh (D5).
//
// Safety rules:
// - a generated note never overwrites an existing file silently: a same-id, same-title note asks Replace (only
//   when it has no recorded results, after a destructive confirm, as one undoable editor change), New numbered
//   note, or Skip (the default);
// - every workflow id becomes part of a file name, so it must pass isCatalogId or the entry is skipped;
// - a vault switch on the way writes nothing (guard.check() before every write, D11).
import type { PickItem } from '@labnoteo/core';
import { hasRecordedResults } from '@labnoteo/core';
import * as posix from '@labnoteo/core/posix';
import { createWorkflowFileName, getNextWorkflowNumber } from '@labnoteo/core/lib/workflowStructure';
import { getLang } from '../i18n/lang';
import { t } from '../i18n/t';
import type { CommandContext } from '../labnote/commands/context';
import { registerWorkflowInReadme } from '../labnote/commands/workflow';
import { NoteBusyError, NoteGoneError, NoteSaveError } from '../labnote/noteErrors';
import { processNote } from '../labnote/openNotes';
import { resolveReadmePath } from '../labnote/paths';
import { experimentReadmes, resolveLabnoteDir, warnIfWindowsPathTooLong } from '../labnote/port/experiments';
import {
  bfwGenerateNotes,
  bfwRequest,
  NetError,
  vaultGuard,
  type InvokeFn,
  type ListenFn,
  type VaultGuard,
} from '../integrations/netIpc';
import { withProgress } from '../integrations/progressStore';
import { bfwErrorText } from './bfwApp';
import { isCatalogId } from './catalogMap';
import { groupCatalogId, savedNotes, serviceDesignToFlow } from './designToFlow';

/** One workflow note from the server, in the server's field names. */
interface NoteEntry {
  group_node_id: string;
  workflow_id: string;
  workflow_name: string;
  markdown: string;
}

interface Service {
  id: string;
  name: string;
  code: string;
  version: number | null;
  hasDraft: boolean;
  workflows: number;
}

const TITLE_MAX = 200;
const FAILED_MARK = '노트 생성 중 오류';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function records(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? v.filter(isRecord) : [];
}

const text = (v: unknown): string => (typeof v === 'string' ? v : '');

/** The server's service ids are path segments: the Rust allow-list takes `[A-Za-z0-9_-]{1,64}` only. */
const SERVICE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * A placeholder the server returns for a workflow whose generation failed (`per_workflow` gives it back with no
 * error flag): `> **<id>** … 노트 생성 중 오류 …`, a single blockquote line, or nothing at all.
 */
export function isFailedNote(n: { workflow_id: string; markdown: string }): boolean {
  const s = n.markdown.trim();
  if (s === '') return true;
  if (n.workflow_id && s.startsWith(`> **${n.workflow_id}**`) && s.includes(FAILED_MARK)) return true;
  return s.startsWith('>') && !/[\r\n]/.test(s);
}

/** A workflow name made safe for a file name and a README checklist line: one line, collapsed spaces, 200 chars. */
export function safeTitle(name: unknown): string {
  if (typeof name !== 'string') return '';
  const one = name.replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/g, ' ').trim();
  return Array.from(one).slice(0, TITLE_MAX).join('').trim();
}

function toService(r: Record<string, unknown>): Service | undefined {
  if (typeof r.id !== 'string' || !SERVICE_ID.test(r.id) || typeof r.name !== 'string') return undefined;
  const version = typeof r.current_version_number === 'number' ? r.current_version_number : null;
  const draftCount = typeof r.draft_workflow_count === 'number' ? r.draft_workflow_count : undefined;
  const count = typeof r.workflow_count === 'number' ? r.workflow_count : 0;
  return {
    id: r.id,
    name: r.name,
    code: text(r.code),
    version,
    hasDraft: r.has_draft === true,
    // An unpublished design has no published counts; the draft's own count stands in when the server gives it.
    workflows: version === null && draftCount !== undefined ? draftCount : count,
  };
}

/** `code · v{n} · {k} workflows`; an unpublished design shows `draft` (never `vnull`). */
function serviceDetail(s: Service): string {
  const parts: string[] = [];
  if (s.code) parts.push(s.code);
  if (s.version !== null) parts.push(`v${s.version}`);
  else if (s.hasDraft) parts.push(t('bfw.draft'));
  parts.push(t('bfw.workflowCount', s.workflows));
  return parts.join(' · ');
}

/** The experiment folder for the notes: the open note's experiment, else one the user picks. */
async function destination(ctx: CommandContext): Promise<string | undefined> {
  const { host } = ctx;
  // No warning when nothing is open: the picker below is the answer to that.
  const quiet = { notify: () => undefined, t: host.t };
  const dir = resolveLabnoteDir(quiet, ctx.activePath());
  if (dir) return dir;
  const list = await experimentReadmes(host);
  if (list.length === 0) {
    host.notify('warn', t('bfw.noExperiment'));
    return undefined;
  }
  return host.pick(
    list.map((r) => ({ label: r.title, detail: r.folder, value: r.folder })),
    { placeholder: t('bfw.pickExperiment') },
  );
}

/** The workflow entries of a generation result. The single-note path gives one entry named after the design. */
function entriesOf(result: unknown, design: unknown, designName: string): NoteEntry[] {
  if (!isRecord(result)) return [];
  const out: NoteEntry[] = records(result.workflows).map((w) => ({
    group_node_id: text(w.group_node_id),
    workflow_id: text(w.workflow_id),
    workflow_name: text(w.workflow_name),
    markdown: text(w.markdown),
  }));
  if (typeof result.markdown === 'string' && result.markdown.trim() !== '') {
    const groups = serviceDesignToFlow(design).nodes.filter((n) => n.type === 'workflowGroup');
    out.push({
      group_node_id: groups.length === 1 ? groups[0].id : '',
      workflow_id: '',
      workflow_name: designName,
      markdown: result.markdown,
    });
  }
  return out;
}

/** A catalog workflow id for the entry (its own, or its group's), or undefined when there is no safe one. */
function workflowIdOf(e: NoteEntry, design: unknown): string | undefined {
  if (isCatalogId(e.workflow_id, 'workflow')) return e.workflow_id;
  const fromGroup = e.group_node_id ? groupCatalogId(design, e.group_node_id) : undefined;
  return isCatalogId(fromGroup, 'workflow') ? fromGroup : undefined;
}

type ExistingChoice = 'replace' | 'new' | 'skip';

/** Ask what to do with an existing same-id, same-title note. Escape is Skip. */
async function askExisting(ctx: CommandContext, existingPath: string): Promise<ExistingChoice> {
  const { host } = ctx;
  let recorded = true;
  try {
    recorded = hasRecordedResults(await host.fs.read(existingPath));
  } catch {
    // Unreadable: never offered for replacement.
  }
  const items: PickItem<ExistingChoice>[] = [
    ...(recorded ? [] : [{ label: t('bfw.replace'), value: 'replace' as const }]),
    { label: t('bfw.newNumbered'), value: 'new' },
    { label: t('bfw.skip'), value: 'skip' },
  ];
  const choice = await host.pick(items, { placeholder: t('bfw.exists', posix.basename(existingPath)) });
  if (choice !== 'replace') return choice ?? 'skip';
  const ok = await host.confirm(t('bfw.replaceConfirm', posix.basename(existingPath)), {
    confirmLabel: t('bfw.replace'),
    destructive: true,
  });
  return ok ? 'replace' : 'skip';
}

interface WriteReport {
  written: string[];
  failed: string[];
  unsafe: number;
}

/** Write each entry by the write rule. `names` is read once and grows with every name written. */
async function writeEntries(
  ctx: CommandContext,
  guard: VaultGuard,
  dir: string,
  entries: readonly NoteEntry[],
  design: unknown,
): Promise<WriteReport> {
  const { host } = ctx;
  const report: WriteReport = { written: [], failed: [], unsafe: 0 };
  const names = [...(await host.fs.list(dir))];
  for (const e of entries) {
    if (isFailedNote(e)) {
      report.failed.push(workflowIdOf(e, design) ?? (e.workflow_id || '?'));
      continue;
    }
    const id = workflowIdOf(e, design);
    if (!id) {
      report.unsafe++;
      continue;
    }
    const title = safeTitle(e.workflow_name) || id;
    const info = { id, name: title, description: '' };
    // Same id and same title: the file name past its `NNN_` sequence is the same.
    const tail = createWorkflowFileName('000', info).slice(4).toLowerCase();
    const same = names.find((n) => /^\d{3}_/.test(n) && n.slice(4).toLowerCase() === tail);
    if (same) {
      const existingPath = posix.join(dir, same);
      const choice = await askExisting(ctx, existingPath);
      if (choice === 'skip') continue;
      if (choice === 'replace') {
        await guard.check();
        try {
          await processNote(host.fs, existingPath, () => e.markdown.replace(/\r\n?/g, '\n'));
          report.written.push(existingPath);
        } catch (err) {
          if (err instanceof NoteBusyError) host.notify('warn', t('command.noteBusy'));
          else if (err instanceof NoteGoneError) host.notify('warn', t('command.noteGone'));
          else if (err instanceof NoteSaveError) host.notify('error', t('command.noteNotSaved'));
          else throw err;
        }
        continue;
      }
    }
    const fileName = createWorkflowFileName(getNextWorkflowNumber(names), info);
    const path = posix.join(dir, fileName);
    if (posix.dirname(path) !== dir || posix.basename(path) !== fileName) {
      report.unsafe++;
      continue;
    }
    if (await host.fs.exists(path)) {
      host.notify('warn', t('bfw.exists', fileName));
      continue;
    }
    await guard.check();
    await host.fs.write(path, e.markdown);
    names.push(fileName);
    report.written.push(path);
    warnIfWindowsPathTooLong(host, ctx.vaultRoot, path);
    await guard.check();
    try {
      await registerWorkflowInReadme(ctx, await resolveReadmePath(ctx.host.fs, dir), { title, fileName });
    } catch (err) {
      if (!(err instanceof NoteBusyError || err instanceof NoteSaveError)) throw err;
      host.notify('warn', t('workflow.readmeNotUpdated', host.t('Sync workflow checklist with folder')));
    }
  }
  return report;
}

/** The user sentence for a failure, or undefined for a cancel. Never Rust's raw text. */
function errorText(e: NetError, ctx: CommandContext, scope: 'read' | 'ai'): string | undefined {
  if (e.kind === 'cancelled') return undefined;
  if (e.kind === 'status' && e.status === 503 && (e.body ?? '').includes('llm_key_missing')) return t('bfw.serverNoLlm');
  if (e.kind === 'remote') return t('bfw.failed', e.message);
  if (e.kind === 'noResult') return t('bfw.noResult');
  return bfwErrorText(e, { connection: ctx.settings.bfwConnection, url: ctx.settings.bfwUrl, scope });
}

/**
 * Run "bfworkflow: Create notes from a design". Reads only `read`-scope GET endpoints and the `ai`-scope notes
 * stream; never a write-scope call. Failures end as one warning toast.
 */
export async function runNotesFromDesign(ctx: CommandContext, invoke?: InvokeFn, listen?: ListenFn): Promise<void> {
  const { host } = ctx;
  let scope: 'read' | 'ai' = 'read';
  try {
    const guard = await vaultGuard(invoke);
    const services = records(
      await bfwRequest({ path: '/api/services', query: [['include_archived', 'false']] }, invoke),
    )
      .map(toService)
      .filter((s): s is Service => s !== undefined);
    if (services.length === 0) {
      host.notify('info', t('bfw.noDesigns'));
      return;
    }
    const service = await host.pick(
      services.map((s) => ({ label: s.name, detail: serviceDetail(s), value: s })),
      { placeholder: t('bfw.pickDesign') },
    );
    if (!service) return;

    const design = await bfwRequest({ path: `/api/services/${service.id}/current-design` }, invoke);
    const saved = savedNotes(design);
    let useSaved = false;
    if (saved.length > 0) {
      const choice = await host.pick<'saved' | 'generate'>([
        { label: t('bfw.useSaved'), value: 'saved' },
        { label: t('bfw.generate'), value: 'generate' },
      ]);
      if (!choice) return;
      useSaved = choice === 'saved';
    }

    // Ask for the experiment before generating, so a dismissed picker costs no generation.
    const dir = await destination(ctx);
    if (!dir) return;

    let entries: NoteEntry[];
    if (useSaved) {
      entries = saved.map((n) => ({
        group_node_id: n.groupNodeId,
        workflow_id: n.workflowId,
        workflow_name: n.workflowName,
        markdown: n.markdown,
      }));
    } else {
      scope = 'ai';
      const result = await withProgress(
        t('bfw.generating'),
        (p) =>
          bfwGenerateNotes(
            {
              design: serviceDesignToFlow(design),
              language: getLang(),
              perWorkflow: true,
              signal: p.signal,
              onProgress: (e) => p.line(e.message),
            },
            invoke,
            listen,
          ),
        { cancellable: true },
      );
      entries = entriesOf(result, design, service.name);
      if (entries.length === 0) {
        host.notify('warn', t('bfw.noResult'));
        return;
      }
    }

    await guard.check();
    const report = await writeEntries(ctx, guard, dir, entries, design);
    if (report.written.length > 0) {
      ctx.refresh();
      await ctx.openFile(report.written[0]);
      host.notify('info', t('bfw.notesWritten', report.written.length, dir));
    }
    const skipped = [
      report.failed.length > 0 ? t('bfw.notesFailed', report.failed.join(', ')) : '',
      report.unsafe > 0 ? t('bfw.notesUnsafe', report.unsafe) : '',
    ].filter(Boolean);
    if (skipped.length > 0) host.notify('warn', skipped.join(' '));
  } catch (e) {
    if (!(e instanceof NetError)) throw e;
    const message = errorText(e, ctx, scope);
    if (message) host.notify('warn', message);
  }
}
