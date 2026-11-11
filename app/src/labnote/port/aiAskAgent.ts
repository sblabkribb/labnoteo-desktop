// Ported from app/vendor/labnoteo/src/llm/commands.ts:1005-1115 sha256:81a212c99e6b324c
// labnoteO 0.140.2, Apache-2.0.
// Changes: LabnotePlugin → AiEnv (ai/aiEnv.ts); createLlmProvider(plugin.settings) → env.provider; plugin.host.editTarget() → env.ctx.host.editTarget() (the app EditTarget over the open editor); plugin.t → env.host.t (coreT, the plugin keys); new Notice(m, ms) → env.host.notify ('info' for 'Open a lab note first.' and the end notice, 'warn' for the 10 s notices); 'Configure an AI provider in settings first.' → notify('info', overrideOr('ai.configureFirst')) (D21). promptModal → env.host.prompt with the same title, prompt and placeholder. The persistent 'Contacting {0}…' Notice → a cancellable progress dialog (withProgress) around each model turn, so it is closed while an approval is asked (D18: the dialog queue shows one at a time) and reopens for the next turn; Cancel in it aborts the whole run. A vaultGuard() is taken before the goal prompt (D11): its signal is linked into the one signal passed to runAgent (so a vault switch ends the run before the next model turn and before any tool runs), and every write of the tools (writeNote through toolContext's beforeWrite, and fs write, modify, mkdir, remove and rmdir) awaits guard.check() first; a failed check also aborts the run. Sample registries a tool wrote are announced through env.sampleEnv().changed (vendor: the tool's own refresh through Obsidian's vault events), but not after a switch. aiAnswerModal(plugin.app, …) → aiAnswerDialog, not awaited; insertBlock takes env. plugin.markUserEdit is removed (the editor stamps on user edits). A cancelled run (describeLlmError gives '') shows nothing. The user message joins the vendor's template parts with '\n' (src/__tests__/escapes.test.ts reads "note:" followed by an escape as a drive path); the string is the same. The system prompt, the 6000-char cap and the notice texts are the vendor's. feat/ai-context (spec §9): after the goal prompt the experiment scope is resolved from the active note (resolveScope over experimentReadmes) and scopeGate(goal, experiments) gives the folders the request names; inside an experiment runAgent gets deps.tools = appTools({ scope, allowedFolders }) (core tools with a documentPath limited to the experiment, plus list_experiment, search_experiment and read_note), outside one the core tools plus the unscoped list_experiment; the tool context carries scope, allowedFolders, experiments and searchIn (searchNotesIn); the system prompt lists those tools instead of createLabnoteTools() and names the experiment folder. Task 9 (spec §7.2-§7.5): externalAgentTools(env) adds external tools after the core ones in both branches and runAgent gets their side map as deps.external; the system prompt gets UNTRUSTED_RULES only when an external tool is offered; confirm builds the app's own text for an external tool (externalApprovalMessage: server, tool, why it asks, the arguments as capped text) and adds ai.confirm.tainted after the core prompt line when outside content reached the run. Task 10: externalAgentTools gets the run's signal (each MCP call is tracked under its own request id, so Cancel sends net_cancel for it) and a warn notify for the once-per-server token toast; the run's AbortController is made before the external tools for that. Task 13: externalAgentTools also gives the literature-search tools of the sources switched on in settings (read-only, results fenced as scholar data, each call tracked under its own request id with the run's signal), before the MCP ones.
// Changes: the system prompt ends its rules with KOREAN_TERMS_INSTRUCTION (aiCommon): an answer in Korean keeps Workflow / Unit Operation in English.
import { caretBeforeModal } from '@labnoteo/core/lib/caret';
import { createLabnoteTools, type ToolDef } from '@labnoteo/core';
import type { AiEnv } from '../../ai/aiEnv';
import { externalAgentTools, externalApprovalMessage } from '../../ai/externalTools';
import { UNTRUSTED_RULES } from '../../ai/untrusted';
import { t as appT } from '../../i18n/t';
import { vaultGuard } from '../../integrations/netIpc';
import { withProgress } from '../../integrations/progressStore';
import { searchNotesIn } from '../../search/indexApi';
import { appTools } from '../context/appTools';
import { contextTools, type ScopedToolContext } from '../context/contextTools';
import { resolveScope, scopeGate, type ExperimentRef, type Scope } from '../context/scope';
import { overrideOr } from '../i18n';
import { experimentReadmes } from './experiments';
import { aiAnswerDialog } from './aiAnswerDialog';
import { insertBlock, KOREAN_TERMS_INSTRUCTION, noAnswerMessage, toolContext, toolRunNotice } from './aiCommon';
import { buildApprovalMessage, erasesRecordedLines } from './approvalMessage';
import { countToolOutcomes, runAgent } from './llmAgent';
import { describeLlmError, outputCutMessage } from './llmError';
import type { LlmProvider } from './llmProvider';

/**
 * Free-form agentic command: the user states a goal and the model reaches it by
 * calling Labnote tools, with every mutating call confirmed.
 *
 * Unlike the commands above, the sequence of tool calls is the model's decision
 * rather than hardcoded here — this is the same capability an external MCP
 * client already had.
 */
export async function askAgentCommand(env: AiEnv): Promise<void> {
  const provider = env.provider;
  if (!provider) {
    // Plugin: 'Configure an AI provider in settings first.'
    env.host.notify('info', overrideOr('ai.configureFirst'));
    return;
  }

  const target = env.ctx.host.editTarget();
  if (!target) {
    env.host.notify('info', env.host.t('Open a lab note first.'));
    return;
  }

  // Read before the goal prompt, the tool approvals and the answer dialog: each
  // takes the focus, and the Source-mode editor then reports the cursor at the
  // start of the note, which put the answer in the front matter (#544).
  const caretBefore = await caretBeforeModal(target);
  const textBefore = await target.getText();

  // Taken before anything is asked: the run must never write into a vault opened meanwhile (D11).
  const guard = await vaultGuard(env.invoke);

  const goal = await env.host.prompt({
    title: env.host.t('Ask the AI assistant'),
    prompt: env.host.t('What should the assistant do?'),
    placeholder: env.host.t('e.g. Add a Method section describing the PCR setup'),
  });
  if (!goal?.trim()) return;

  // The experiment the run reads in, and the other ones the request names (spec §9, §13).
  let experiments: ExperimentRef[] = [];
  try {
    experiments = (await experimentReadmes(env.host)).map(e => ({ folder: e.folder, title: e.title }));
  } catch {
    // No experiment list: only the active note's own folder can be the scope.
  }
  let scope: Scope | undefined;
  try {
    scope = resolveScope({ activePath: target.path }, experiments);
  } catch {
    scope = undefined;
  }
  const allowedFolders = scopeGate(goal, experiments);
  const coreTools: ToolDef[] = scope
    ? appTools({ scope, allowedFolders })
    : [...createLabnoteTools(), ...contextTools().filter(t => t.name === 'list_experiment')];
  // One signal for the whole run: Cancel in a turn's progress dialog, a vault switch, or a failed guard check ends it.
  const run$ = new AbortController();
  const stop = () => run$.abort();
  // External tools (MCP servers, literature search) go after the core ones in both branches (spec §7.5). Each MCP
  // call gets its own request id and the run's signal, so Cancel reaches Rust as net_cancel for that call.
  const external = await externalAgentTools(env, {
    signal: run$.signal,
    notify: message => env.host.notify('warn', message),
  });
  const tools: ToolDef[] = [...coreTools, ...external.tools];
  if (guard.signal.aborted) stop();
  else guard.signal.addEventListener('abort', stop, { once: true });

  // Each model turn waits behind its own progress dialog, so none is open while an approval is asked (D18).
  const turns: LlmProvider = {
    name: provider.name,
    label: provider.label,
    model: provider.model,
    chat: (messages, opts) =>
      withProgress(
        env.host.t('Contacting {0}…', provider.label),
        async p => {
          p.signal.addEventListener('abort', stop, { once: true });
          try {
            return await provider.chat(messages, { ...opts, signal: run$.signal });
          } finally {
            p.signal.removeEventListener('abort', stop);
          }
        },
        { cancellable: true }
      ),
  };

  const check = async (): Promise<void> => {
    try {
      await guard.check();
    } catch (err) {
      stop();
      throw err;
    }
  };
  const base = toolContext(env, {
    beforeWrite: check,
    scope,
    allowedFolders,
    experiments: async () => experiments,
    searchIn: (query, prefix, limit) => searchNotesIn(query, prefix, limit, env.invoke),
  });
  // Registries a tool wrote, announced once the run ends (the index, completion and the Samples panel).
  const written = new Set<string>();
  const wrote = (p: string) => {
    if (p.toLowerCase().endsWith('.json')) written.add(p);
  };
  const ctx: ScopedToolContext = {
    ...base,
    fs: {
      ...base.fs,
      write: async (p: string, c: string) => {
        await check();
        await base.fs.write(p, c);
        wrote(p);
      },
      modify: async (p: string, u: (s: string) => string) => {
        await check();
        const out = await base.fs.modify(p, u);
        wrote(p);
        return out;
      },
      mkdir: async (p: string) => {
        await check();
        return base.fs.mkdir(p);
      },
      remove: async (p: string) => {
        await check();
        return base.fs.remove(p);
      },
      rmdir: async (p: string) => {
        await check();
        return base.fs.rmdir(p);
      },
    },
  };

  const noteText = textBefore.slice(0, 6000);
  try {
    const run = await runAgent(
      [
        {
          role: 'system',
          content:
            'You are a lab notebook assistant. Use the provided tools to inspect and edit the notebook. ' +
            `The active note is "${target.path}"; pass it as documentPath. ` +
            'Prefer reading before writing, and answer briefly in Markdown when done. ' +
            'Your final answer is shown to the user in a dialog and is not written to the note; ' +
            'to change the note, use the tools. ' +
            `Your tools are: ${tools.map(t => t.name).join(', ')}. ` +
            (scope
              ? `The current experiment folder is "${scope.folder}": list_experiment, search_experiment and read_note read only inside it. ` +
                'Use another experiment only when the request names it. '
              : '') +
            'If the request needs something these tools cannot do (for example changing the experiment status), ' +
            'do not pretend: answer that you cannot do it and which Labnote command the user can run instead. ' +
            KOREAN_TERMS_INSTRUCTION +
            (external.tools.length > 0 ? ` ${UNTRUSTED_RULES}` : ''),
        },
        // The vendor's template text, joined so the escapes guard does not read the colon and newline as a drive path.
        { role: 'user', content: [goal, '', 'Active note:', noteText].join('\n') },
      ],
      {
        provider: turns,
        tools,
        ctx,
        temperature: 0.2,
        signal: run$.signal,
        external: external.meta,
        confirm: (call, tool, preview, note) => {
          const meta = external.meta.get(tool.name);
          if (meta) {
            return env.host.confirm(externalApprovalMessage(call, meta, !!tool.mutates, note), {
              confirmLabel: env.host.t('Allow'),
              destructive: false,
            });
          }
          // Show the write target, not just the tool name: the model chooses
          // the path, so approving by name alone is blind approval.
          const path = typeof call.arguments.documentPath === 'string' ? call.arguments.documentPath : null;
          const ask = env.host.t('Allow AI tool "{0}" to modify the vault?', tool.name);
          // After outside content the user is told this write may come from it (spec §7.4).
          const prompt = note?.tainted ? `${ask}

${appT('ai.confirm.tainted')}` : ask;
          return env.host.confirm(buildApprovalMessage(env.host.t, prompt, path, preview), {
            confirmLabel: env.host.t('Allow'),
            destructive: erasesRecordedLines(preview),
          });
        },
      }
    );

    if (run.stoppedAtLimit) {
      env.host.notify('warn', `${env.host.t('AI stopped after too many steps.')} ${toolRunNotice(env, run.executed)}`);
      return;
    }
    const answer = run.content;
    if (!answer.trim()) {
      // No answer to show; the tool summary below still says what happened
      // (#161, #186). After a change that summary is the answer: "try again"
      // would invite doing it twice (#286).
      if (countToolOutcomes(run.executed).changed === 0) {
        env.host.notify(
          'warn',
          run.thinkingOnly
            ? noAnswerMessage(env, true)
            : run.executed.length === 0
              ? env.host.t('The assistant gave no answer. What you asked may be outside the tools it can use.')
              : env.host.t('The assistant gave no answer.')
        );
      }
    } else {
      // An answer cut at the output cap is still offered, with a warning that its end may be missing.
      if (run.truncated) env.host.notify('warn', outputCutMessage());
      // The answer only goes in on request (#77), possibly minutes later, so
      // the note must still be the one open.
      void aiAnswerDialog({
        content: answer,
        sourcePath: target.path,
        onInsert: async () => {
          const current = env.ctx.host.editTarget();
          if (current?.path !== target.path) {
            env.host.notify('info', env.host.t('That note is no longer open. Copy the answer instead.'));
            return false;
          }
          // A tool the agent ran, or the user writing on, moved everything the
          // saved cursor pointed at: the answer goes at the end instead.
          const latest = await current.getText();
          await insertBlock(env, current, answer, {
            caret: latest === textBefore ? caretBefore : latest.length,
          });
          return true;
        },
      });
    }
    env.host.notify('info', toolRunNotice(env, run.executed));
  } catch (err) {
    const message = describeLlmError(err, env.settings(), env.t);
    if (message) {
      console.error('[labnoteo] AI request failed:', err);
      env.host.notify('warn', message);
    }
  } finally {
    guard.signal.removeEventListener('abort', stop);
    // After a switch these relative paths would be read in the new vault.
    if (written.size > 0 && !run$.signal.aborted) env.sampleEnv().changed([...written]);
  }
}
