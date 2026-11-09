// @vitest-environment jsdom
/**
 * The MCP host in the webview (Task 36): `mcp://call` runs a tool, a mutating one only after the user's
 * unsolicited-safe approval, and every tool runs only after `guard.check()` and a granted `mcp_claim`.
 * Rust is a fake `invoke` (`mcp_claim`, `mcp_reply`, `vault_current`); the dialogs are the real dialog layer;
 * the tools are the real core tools over the fake vault.
 */
import { act, fireEvent, screen } from '@testing-library/react';
import type { EditorView } from '@codemirror/view';
import { runTool } from '@labnoteo/core';
import { setLang } from '../../../i18n/lang';
import { t } from '../../../i18n/t';
import { fakeInvoke } from '../../../integrations/__tests__/fakeNet';
import { cancelAllRequests, type ListenFn } from '../../../integrations/netIpc';
import { createTestHost, type TestHost } from '../../__tests__/testHost';
import { cleanupDialogs, renderLayer } from '../../host/__tests__/harness';
import { closeAllDialogs, confirmDialog, currentDialog } from '../../host/dialogStore';
import { coreT } from '../../i18n';
import { openNote, processNote } from '../../openNotes';
import { buildApprovalMessage } from '../../port/approvalMessage';
import { APPROVAL_TIMEOUT_MS } from '../../port/mcpApproval';
import { startMcpHost, toolCatalog } from '../mcpHost';
import { MCP_CALL, MCP_CANCEL, type McpReplyIn } from '../mcpIpc';

vi.mock('../../openNotes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../openNotes')>();
  return { ...actual, processNote: vi.fn(actual.processNote) };
});
vi.mock('@labnoteo/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@labnoteo/core')>();
  return { ...actual, runTool: vi.fn(actual.runTool) };
});

const NOTE = 'e/01_x.labnote.md';
const BODY = ['# x', '', '## Method', '', 'old', '', '## Result', '', 'r', ''].join('\n');
const CLOSED: McpReplyIn = { kind: 'error', code: -32002, message: 'labnoteO closed the vault; nothing was written' };

type Handler = (e: { payload: unknown }) => void;

let hosts: TestHost[] = [];
let stops: Array<() => void> = [];

/** Lets the host's promises (vault guard, claim, tool, reply) run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 30; i++) await act(async () => undefined);
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  await flush();
}

function setup(opts: { claim?: (a: Record<string, unknown>) => unknown; mount?: boolean } = {}) {
  const th = createTestHost({ [NOTE]: BODY });
  hosts.push(th);
  const confirm = vi.fn((message: string, o?: Parameters<typeof confirmDialog>[1]) => confirmDialog(message, o));
  th.host.confirm = confirm;
  let root = 'C:/Vault';
  const f = fakeInvoke({
    mcp_claim: opts.claim ?? (() => true),
    mcp_reply: () => true,
    vault_current: () => ({ root, name: 'Vault' }),
    net_cancel: () => null,
  });
  const handlers = new Map<string, Handler>();
  const listen = (async (name: string, h: Handler) => {
    handlers.set(name, h);
    return () => handlers.delete(name);
  }) as unknown as ListenFn;
  const stop = startMcpHost(th.ctx, { invoke: f.invoke, listen });
  stops.push(stop);
  const call = (callId: string, name: string, args: Record<string, unknown>, mutates: boolean) =>
    act(() => handlers.get(MCP_CALL)!({ payload: { callId, name, args, mutates } }));
  const cancel = (callId: string) => act(() => handlers.get(MCP_CANCEL)!({ payload: { callId } }));
  const replies = () => f.calls.filter(([c]) => c === 'mcp_reply').map(([, a]) => a as { callId: string; reply: McpReplyIn });
  const cmds = () => f.calls.map(([c]) => c).filter((c) => c.startsWith('mcp_'));
  return { th, f, confirm, call, cancel, replies, cmds, handlers, switchVault: (r: string) => void (root = r) };
}

const update = (content: string) => ({ documentPath: NOTE, heading: 'Method', content });
const allow = () => fireEvent.click(screen.getByRole('button', { name: coreT('Allow') }));
const deny = () => fireEvent.click(screen.getByRole('button', { name: t('dialog.cancel') }));
const isOpen = () => currentDialog() !== null;

beforeEach(() => {
  setLang('en');
  renderLayer();
});
afterEach(() => {
  for (const s of stops.splice(0)) s();
  for (const th of hosts.splice(0)) th.cleanup();
  closeAllDialogs();
  cleanupDialogs();
  vi.useRealTimers();
  vi.mocked(processNote).mockClear();
  vi.mocked(runTool).mockClear();
});

describe('MCP host (Task 36)', () => {
  it('the tool catalog is the core tools, with mutates', () => {
    const cat = toolCatalog();
    expect(cat.find((x) => x.name === 'read_section')).toMatchObject({ mutates: false });
    expect(cat.find((x) => x.name === 'update_section')).toMatchObject({ mutates: true });
    for (const x of cat) expect(Object.keys(x).sort()).toEqual(['description', 'inputSchema', 'mutates', 'name']);
  });

  it('a read tool runs without asking and replies the tool result', async () => {
    vi.useFakeTimers();
    const s = setup();
    await flush();
    await s.call('c1', 'read_section', { documentPath: NOTE }, false);
    await flush();
    expect(s.confirm).not.toHaveBeenCalled();
    expect(s.cmds()).toEqual(['mcp_claim', 'mcp_reply']);
    expect(s.f.calls.find(([c]) => c === 'mcp_claim')![1]).toEqual({ callId: 'c1' });
    const [r] = s.replies();
    expect(r.callId).toBe('c1');
    expect(r.reply).toMatchObject({ kind: 'result', result: { isError: false } });
    const result = (r.reply as { result: { content: Array<{ text: string }> } }).result;
    expect(JSON.parse(result.content[0].text).content).toBe(BODY);
  });

  it('an unknown tool replies an isError result, as the plugin does', async () => {
    vi.useFakeTimers();
    const s = setup();
    await flush();
    await s.call('c1', 'nope', {}, false);
    await flush();
    expect(s.replies()).toEqual([
      { callId: 'c1', reply: { kind: 'result', result: { isError: true, content: [{ type: 'text', text: JSON.stringify('Unknown tool: nope') }] } } },
    ]);
  });

  it('a mutating tool asks with the approval message and writes only on Allow', async () => {
    vi.useFakeTimers();
    const s = setup();
    await flush();
    await s.call('c1', 'update_section', update('new'), true);
    await flush();
    expect(s.confirm).toHaveBeenCalledTimes(1);
    const [message, o] = s.confirm.mock.calls[0];
    expect(message.startsWith(buildApprovalMessage(coreT, coreT('Allow MCP tool "{0}" to modify the vault?', 'update_section'), NOTE))).toBe(true);
    expect(o).toMatchObject({ confirmLabel: coreT('Allow'), unsolicited: true });
    expect(s.th.vault.files()[NOTE]).toBe(BODY);
    expect(processNote).not.toHaveBeenCalled();
    await advance(600);
    allow();
    await flush();
    expect(processNote).toHaveBeenCalledTimes(1);
    expect(s.th.vault.files()[NOTE]).toContain('new');
    expect(s.cmds()).toEqual(['mcp_claim', 'mcp_reply']);
    expect(s.replies()[0].reply).toMatchObject({ kind: 'result', result: { isError: false } });
  });

  it('a late Allow after mcp://cancel runs no tool', async () => {
    vi.useFakeTimers();
    const s = setup();
    await flush();
    await s.call('c1', 'update_section', update('new'), true);
    await flush();
    expect(isOpen()).toBe(true);
    await s.cancel('c1');
    await flush();
    expect((s.confirm.mock.calls[0][1] as { signal: AbortSignal }).signal.aborted).toBe(true);
    expect(isOpen()).toBe(false);
    // the dialog is gone: an Allow now has nothing to answer
    expect(screen.queryByRole('button', { name: coreT('Allow') })).toBeNull();
    await advance(APPROVAL_TIMEOUT_MS);
    expect(processNote).not.toHaveBeenCalled();
    expect(runTool).not.toHaveBeenCalled();
    expect(s.cmds()).toEqual(['mcp_reply']);
    expect(s.replies()).toEqual([{ callId: 'c1', reply: { kind: 'noReply' } }]);
    expect(s.th.notes).toContainEqual({ kind: 'warn', message: coreT('MCP tool "{0}" was not run: the client disconnected.', 'update_section') });
  });

  it('a claim refused by Rust runs no tool', async () => {
    vi.useFakeTimers();
    const s = setup({ claim: () => false });
    await flush();
    await s.call('c1', 'update_section', update('new'), true);
    await flush();
    await advance(600);
    allow();
    await flush();
    expect(s.cmds()).toEqual(['mcp_claim']);
    expect(processNote).not.toHaveBeenCalled();
    expect(runTool).not.toHaveBeenCalled();
    expect(s.replies()).toEqual([]);
    expect(s.th.vault.files()[NOTE]).toBe(BODY);
  });

  it('denied replies -32001 User denied write', async () => {
    vi.useFakeTimers();
    const s = setup();
    await flush();
    await s.call('c1', 'update_section', update('new'), true);
    await flush();
    deny();
    await flush();
    expect(s.replies()).toEqual([{ callId: 'c1', reply: { kind: 'error', code: -32001, message: 'User denied write' } }]);
    expect(s.cmds()).toEqual(['mcp_reply']);
    expect(s.th.vault.files()[NOTE]).toBe(BODY);
  });

  it('an approval that times out replies -32001 naming labnoteO and says so', async () => {
    vi.useFakeTimers();
    const s = setup();
    await flush();
    await s.call('c1', 'update_section', update('new'), true);
    await flush();
    await advance(APPROVAL_TIMEOUT_MS + 1);
    expect(isOpen()).toBe(false);
    expect(s.replies()).toEqual([
      { callId: 'c1', reply: { kind: 'error', code: -32001, message: 'Approval timed out: the user did not answer in labnoteO' } },
    ]);
    expect(s.th.notes).toContainEqual({ kind: 'warn', message: coreT('MCP tool "{0}" was not run: no answer in time.', 'update_section') });
  });

  it('two mutating calls are asked one after the other', async () => {
    vi.useFakeTimers();
    const s = setup();
    await flush();
    await s.call('c1', 'update_section', update('one'), true);
    await s.call('c2', 'update_section', { ...update('two'), mode: 'append' }, true);
    await flush();
    expect(s.confirm).toHaveBeenCalledTimes(1);
    await advance(600);
    allow();
    await flush();
    expect(s.confirm).toHaveBeenCalledTimes(2);
    expect(s.replies().map((r) => r.callId)).toEqual(['c1']);
    await advance(600);
    allow();
    await flush();
    expect(s.replies().map((r) => r.callId)).toEqual(['c1', 'c2']);
    const text = s.th.vault.files()[NOTE];
    expect(text).toContain('one');
    expect(text).toContain('two');
  });

  it('a call queued behind another approval gets its own full approval window', async () => {
    vi.useFakeTimers();
    const s = setup();
    await flush();
    await s.call('c1', 'update_section', update('one'), true);
    await s.call('c2', 'update_section', { ...update('two'), mode: 'append' }, true);
    await flush();
    await advance(49_000);
    allow();
    await flush();
    expect(s.confirm).toHaveBeenCalledTimes(2);
    await advance(49_000);
    expect(isOpen()).toBe(true);
    expect(s.replies().map((r) => r.callId)).toEqual(['c1']);
    await advance(2_000);
    expect(isOpen()).toBe(false);
    expect(s.replies()[1]).toEqual({
      callId: 'c2',
      reply: { kind: 'error', code: -32001, message: 'Approval timed out: the user did not answer in labnoteO' },
    });
  });

  it('a call emitted before a drain is not run after the vault switch', async () => {
    vi.useFakeTimers();
    let answer!: (v: boolean) => void;
    const held = new Promise<boolean>((r) => (answer = r));
    const s = setup({ claim: () => held });
    await flush();
    await s.call('c3', 'read_section', { documentPath: NOTE }, false);
    await flush();
    expect(s.cmds()).toEqual(['mcp_claim']);
    // the app drains and switches vault while the claim is on its way
    s.switchVault('C:/Other');
    await act(async () => {
      await cancelAllRequests(s.f.invoke);
    });
    answer(false);
    await flush();
    expect(runTool).not.toHaveBeenCalled();
    expect(s.replies()).toEqual([]);
  });

  it('an Enter typed into the editor as the MCP approval opens does not approve', async () => {
    vi.useFakeTimers();
    const s = setup();
    const editor = document.createElement('textarea');
    document.body.appendChild(editor);
    editor.focus();
    await flush();
    // an append erases nothing, so a solicited dialog would focus Allow
    await s.call('c1', 'update_section', { ...update('new'), mode: 'append' }, true);
    await flush();
    expect(isOpen()).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: t('dialog.cancel') }));
    for (const at of [0, 250, 499]) {
      if (at) await advance(at === 250 ? 250 : 249);
      // the key's default action (pressing the button) is prevented: fireEvent returns false
      expect(fireEvent.keyDown(document.activeElement!, { key: 'Enter' })).toBe(false);
      expect(fireEvent.keyDown(screen.getByRole('button', { name: coreT('Allow') }), { key: 'Enter' })).toBe(false);
      await flush();
      expect(isOpen()).toBe(true);
    }
    expect(processNote).not.toHaveBeenCalled();
    expect(s.cmds()).toEqual([]);
    expect(s.th.vault.files()[NOTE]).toBe(BODY);
    editor.remove();
  });

  it('an approval is not opened while composing and opens after compositionend', async () => {
    vi.useFakeTimers();
    const s = setup();
    const view = { composing: true, contentDOM: document.createElement('div') } as unknown as EditorView & { composing: boolean };
    s.th.ctx.activeView = () => view;
    await flush();
    await s.call('c1', 'update_section', update('new'), true);
    await flush();
    await advance(10_000);
    expect(isOpen()).toBe(false);
    expect(s.confirm).not.toHaveBeenCalled();
    view.composing = false;
    act(() => {
      view.contentDOM.dispatchEvent(new Event('compositionend'));
    });
    await flush();
    expect(isOpen()).toBe(true);
    // the 50 s approval window starts when the dialog opens
    await advance(49_000);
    expect(isOpen()).toBe(true);
    expect(s.replies()).toEqual([]);
    await advance(2_000);
    expect(s.replies()[0].reply).toMatchObject({ kind: 'error', code: -32001 });
  });

  it('a vault switch during approval writes nothing', async () => {
    vi.useFakeTimers();
    const s = setup();
    await flush();
    await s.call('c1', 'update_section', update('new'), true);
    await flush();
    expect(isOpen()).toBe(true);
    s.switchVault('C:/Other');
    await act(async () => {
      await cancelAllRequests(s.f.invoke);
      closeAllDialogs();
    });
    await flush();
    expect(processNote).not.toHaveBeenCalled();
    expect(s.th.vault.files()[NOTE]).toBe(BODY);
    expect(s.replies()).toEqual([{ callId: 'c1', reply: CLOSED }]);
  });

  it('with no vault open a call replies -32002 and runs nothing', async () => {
    vi.useFakeTimers();
    const s = setup();
    s.switchVault(undefined as unknown as string);
    await flush();
    await s.call('c1', 'read_section', { documentPath: NOTE }, false);
    await flush();
    expect(runTool).not.toHaveBeenCalled();
    expect(s.replies()).toEqual([{ callId: 'c1', reply: CLOSED }]);
  });

  it('writes into a composing open note are refused by toolContext, not applied', async () => {
    const s = setup();
    await s.th.mount(NOTE);
    // the approval opens from another pane; the note is open in the editor
    s.th.ctx.activeView = () => undefined;
    vi.useFakeTimers();
    await flush();
    await s.call('c1', 'update_section', update('new'), true);
    await flush();
    expect(isOpen()).toBe(true);
    const view = openNote(NOTE)!.view()!;
    Object.defineProperty(view, 'composing', { configurable: true, get: () => true });
    await advance(600);
    allow();
    await flush();
    expect(view.state.doc.toString()).toBe(BODY);
    expect(s.th.vault.files()[NOTE]).toBe(BODY);
    expect(s.replies()).toHaveLength(1);
    expect(s.replies()[0].reply).toMatchObject({ kind: 'result', result: { isError: true } });
  });

  it('stopping the host withdraws an open approval and runs nothing', async () => {
    vi.useFakeTimers();
    const s = setup();
    await flush();
    await s.call('c1', 'update_section', update('new'), true);
    await flush();
    expect(isOpen()).toBe(true);
    stops.pop()!();
    await flush();
    expect(isOpen()).toBe(false);
    expect(s.handlers.size).toBe(0);
    expect(processNote).not.toHaveBeenCalled();
  });

  it('APPROVAL_TIMEOUT_MS stays under the read cap', () => {
    expect(APPROVAL_TIMEOUT_MS).toBeLessThan(55_000);
  });
});
