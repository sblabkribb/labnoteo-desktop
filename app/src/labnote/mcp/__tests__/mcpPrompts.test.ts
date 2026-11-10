// MCP prompt filling in the webview (ai-context spec §10.2, plan Task 13):
// draft-unit-operation and continue-workflow over the shared context builder,
// scoped by notePath to one experiment folder, planning sections only.
import { describe, expect, it } from 'vitest';
import type { LabnoteFs } from '@labnoteo/core';
import type { ScopedToolContext } from '../../context/contextTools';
import { PLANNING_RULES } from '../../context/planningPrompt';
import {
  buildFixtureVault,
  EXP_OTHER,
  FIXTURE_EXPERIMENTS,
  GLOBAL_SAMPLE_FOLDER,
  LEAK_TEXT,
  MAIN_FILES,
} from '../../context/__tests__/fixtures';
import { fillPrompt, type PromptReply } from '../mcpPrompts';

/** `fs` with every path passed to read or list recorded. */
function spyFs(inner: LabnoteFs): { fs: LabnoteFs; seen: string[] } {
  const seen: string[] = [];
  const fs = new Proxy(inner, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if ((prop === 'read' || prop === 'list') && typeof value === 'function') {
        return (path: string) => {
          seen.push(path);
          return value.call(target, path);
        };
      }
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { fs, seen };
}

async function ctxOf(fs?: LabnoteFs): Promise<ScopedToolContext> {
  return {
    fs: fs ?? (await buildFixtureVault()),
    workspaceRoot: '.',
    globalSampleFolder: GLOBAL_SAMPLE_FOLDER,
    experiments: async () => FIXTURE_EXPERIMENTS.map(e => ({ ...e })),
  };
}

function textOf(reply: PromptReply): { description: string; text: string } {
  expect(reply.kind).toBe('result');
  const { result } = reply as Extract<PromptReply, { kind: 'result' }>;
  expect(result.messages).toHaveLength(1);
  expect(result.messages[0].role).toBe('user');
  expect(result.messages[0].content.type).toBe('text');
  return { description: result.description, text: result.messages[0].content.text };
}

const requestedLine = (text: string): string => text.split('\n').find(l => l.startsWith('Requested sections:')) ?? '';

const HW_LINE = 'Requested sections: Input, Reagent, Labware and Consumables, Equipment, Parameters, Method, Output';

describe('fillPrompt: draft-unit-operation', () => {
  it('holds PLANNING_RULES, the rendered context and every planning section of the target by default', async () => {
    const reply = await fillPrompt('draft-unit-operation', { notePath: MAIN_FILES.expression, unitOp: 'UHW030' }, { toolCtx: await ctxOf() });
    const { description, text } = textOf(reply);
    expect(text.startsWith(PLANNING_RULES)).toBe(true);
    expect(text).toContain('<<source id="target"');
    expect(text).toContain('Target unit operation: ### [UHW030 Induction]');
    expect(requestedLine(text)).toBe(HW_LINE);
    // The deterministic prefill from the previous Output (DNA-4) is a source.
    expect(text).toContain('<<source id="target:input-prefill"');
    expect(description).toContain('UHW030 Induction');
  });

  it('defaults to the last unit op of the note', async () => {
    const { text } = textOf(await fillPrompt('draft-unit-operation', { notePath: MAIN_FILES.cloning }, { toolCtx: await ctxOf() }));
    expect(text).toContain('Target unit operation: ### [UHW020 Gel Purification]');
  });

  it('asks only for the requested planning sections; Results & Discussions is filtered out with a note', async () => {
    const reply = await fillPrompt(
      'draft-unit-operation',
      { notePath: MAIN_FILES.expression, unitOp: '2', sections: 'Method, Results & Discussions, QC Metrics, 방법' },
      { toolCtx: await ctxOf() }
    );
    const { text } = textOf(reply);
    expect(requestedLine(text)).toBe('Requested sections: Method');
    expect(text).toMatch(/Not drafted[^\n]*Results & Discussions, QC Metrics/);
    expect(text).not.toContain('#### Results & Discussions');
    expect(text).not.toContain('#### QC Metrics');
  });

  it('falls back to the planning sections when only researcher sections were asked for', async () => {
    const { text } = textOf(
      await fillPrompt('draft-unit-operation', { notePath: MAIN_FILES.expression, sections: 'Results & Discussions' }, { toolCtx: await ctxOf() })
    );
    expect(requestedLine(text)).toBe(HW_LINE);
    expect(text).toMatch(/Not drafted[^\n]*Results & Discussions/);
  });

  it('never reads or quotes another experiment', async () => {
    const { fs, seen } = spyFs(await buildFixtureVault());
    const { text } = textOf(await fillPrompt('draft-unit-operation', { notePath: MAIN_FILES.cloning }, { toolCtx: await ctxOf(fs) }));
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.some(p => p === EXP_OTHER || p.startsWith(`${EXP_OTHER}/`))).toBe(false);
    expect(text).not.toContain('LEAKED');
    // Results are excluded from the context by default.
    expect(text).not.toContain(LEAK_TEXT);
  });

  it('scope comes from notePath: a path outside any experiment is a -32602 error', async () => {
    for (const notePath of ['notes/free.md', '../labnote/002_발현실험/001_WB010_Cloning.labnote.md', 'C:/x.md']) {
      const reply = await fillPrompt('draft-unit-operation', { notePath }, { toolCtx: await ctxOf() });
      expect(reply).toMatchObject({ kind: 'error', code: -32602 });
      expect((reply as { message: string }).message.length).toBeGreaterThan(0);
    }
  });

  it('a missing notePath, a note that is not a workflow, a workflow without unit ops and an unknown unit op are -32602 errors', async () => {
    const ctx = await ctxOf();
    const err = { kind: 'error', code: -32602 };
    expect(await fillPrompt('draft-unit-operation', {}, { toolCtx: ctx })).toMatchObject(err);
    expect(await fillPrompt('draft-unit-operation', { notePath: 'labnote/002_발현실험/README.labnote.md' }, { toolCtx: ctx })).toMatchObject(err);
    expect(await fillPrompt('draft-unit-operation', { notePath: MAIN_FILES.cloning, unitOp: 'UHW999' }, { toolCtx: ctx })).toMatchObject(err);
    expect(await fillPrompt('draft-unit-operation', { notePath: MAIN_FILES.analysis }, { toolCtx: ctx })).toMatchObject(err);
  });
});

describe('fillPrompt: continue-workflow', () => {
  it('uses the last unit op of the workflow and names the next checklist workflow', async () => {
    const { description, text } = textOf(
      await fillPrompt('continue-workflow', { notePath: MAIN_FILES.cloning, goal: 'express GFP in BL21' }, { toolCtx: await ctxOf() })
    );
    expect(text.startsWith(PLANNING_RULES)).toBe(true);
    expect(text).toContain('Last unit operation so far: ### [UHW020 Gel Purification]');
    expect(text).toContain(`Next workflow in the README checklist: WB020 Protein Expression (${MAIN_FILES.expression})`);
    // The cloning workflow is checked as done, so the first unit op of the next workflow is asked for.
    expect(text).toMatch(/checked as done[^\n]*first unit operation of WB020 Protein Expression/);
    // The next Input is the last Output (deterministic), with the registry name.
    expect(text).toContain('- DNA-3 — insert');
    expect(text).toContain('express GFP in BL21');
    expect(description).toContain('WB010 Cloning');
  });

  it("asks for the next unit operation's planning sections only", async () => {
    const { text } = textOf(await fillPrompt('continue-workflow', { notePath: MAIN_FILES.expression }, { toolCtx: await ctxOf() }));
    expect(requestedLine(text)).toBe(HW_LINE);
    expect(text).toContain('Input, Output, Parameters, Method');
    expect(text).not.toContain('#### Results & Discussions');
    expect(text).toContain('Last unit operation so far: ### [UHW030 Induction]');
    expect(text).toMatch(/If this workflow is complete[^\n]*WB030 Check/);
    // The last unit op's own Input prefill is not offered as the next step's.
    expect(text).not.toContain('<<source id="target:input-prefill"');
    expect(text).toContain('- Protein-1');
  });

  it('a workflow without unit ops asks for its first unit op, fed by the previous workflow', async () => {
    const { text } = textOf(await fillPrompt('continue-workflow', { notePath: MAIN_FILES.analysis }, { toolCtx: await ctxOf() }));
    expect(text).toMatch(/has no unit operations yet/);
    expect(text).toContain('### [UHW050 Ni-NTA]');
    expect(text).toContain('- Protein-2');
  });

  it('a path outside any experiment is a -32602 error', async () => {
    expect(await fillPrompt('continue-workflow', { notePath: 'inbox/a.md' }, { toolCtx: await ctxOf() })).toMatchObject({
      kind: 'error',
      code: -32602,
    });
  });
});

describe('fillPrompt: names', () => {
  it('an unknown prompt name is a -32602 error', async () => {
    for (const name of ['nope', '', 'draft_unit_operation', 'prompt:draft-unit-operation']) {
      expect(await fillPrompt(name, { notePath: MAIN_FILES.cloning }, { toolCtx: await ctxOf() })).toMatchObject({
        kind: 'error',
        code: -32602,
      });
    }
  });
});
