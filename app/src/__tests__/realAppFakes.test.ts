import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { assembleOllama, assembleOpenAi } from '../ai/streamAssembler';

/**
 * 실제 앱 점검용 가짜 서버(plan Task 16): scripts/fakeMcpServer.mjs, fakeScholar.mjs, fakeLlm.mjs.
 * 모두 127.0.0.1 에서만 듣고, 요청 기록(/__log)에 토큰이나 헤더 값을 남기지 않는다.
 */
const running: ChildProcess[] = [];
const TOKEN = 'test-token-123';

async function start(script: string, ...flags: string[]): Promise<string> {
  const child = spawn(process.execPath, [resolve('scripts', script), '--port', '0', ...flags], { stdio: ['ignore', 'pipe', 'pipe'] });
  running.push(child);
  return new Promise((res, rej) => {
    let out = '';
    const timer = setTimeout(() => rej(new Error(`no port: ${out}`)), 10_000);
    child.stdout!.on('data', (d: Buffer) => {
      out += d.toString();
      const m = /http:\/\/127\.0\.0\.1:(\d+)/.exec(out);
      if (m) {
        clearTimeout(timer);
        res(`http://127.0.0.1:${m[1]}`);
      }
    });
    child.on('exit', (code) => rej(new Error(`exited ${code}: ${out}`)));
  });
}

afterEach(() => {
  for (const c of running.splice(0)) c.kill();
});

type Rpc = { jsonrpc: string; id?: number; result?: Record<string, unknown>; error?: { code: number } };

async function rpc(base: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify(body),
  });
}

/** The JSON-RPC message with an id from a JSON or SSE answer. */
async function message(r: Response): Promise<Rpc> {
  const text = await r.text();
  if (!(r.headers.get('content-type') ?? '').startsWith('text/event-stream')) return JSON.parse(text) as Rpc;
  const datas = text
    .split(/\r?\n\r?\n/)
    .map((frame) => frame.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n'))
    .filter((d) => d !== '');
  const msgs = datas.map((d) => JSON.parse(d) as Rpc);
  const withId = msgs.find((m) => m.id !== undefined);
  if (!withId) throw new Error('no response in the stream');
  return withId;
}

const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '0' } } };

describe('fake MCP server', () => {
  for (const mode of ['json', 'sse'] as const) {
    it(`${mode}: initialize gives a session, tools/list and tools/call need it`, async () => {
      const base = await start('fakeMcpServer.mjs', '--token', TOKEN, ...(mode === 'sse' ? ['--sse'] : []));
      const auth = { Authorization: `Bearer ${TOKEN}` };
      const r = await rpc(base, INIT, auth);
      expect(r.status).toBe(200);
      if (mode === 'sse') expect(r.headers.get('content-type')).toMatch(/^text\/event-stream/);
      const sid = r.headers.get('mcp-session-id')!;
      expect(sid).toBeTruthy();
      const init = await message(r);
      expect(init.result).toMatchObject({ protocolVersion: '2025-06-18', serverInfo: { name: 'labnoteO fake MCP', version: '0.0.1-fake' } });

      const s = { ...auth, 'Mcp-Session-Id': sid };
      expect((await rpc(base, { jsonrpc: '2.0', method: 'notifications/initialized' }, s)).status).toBe(202);
      expect((await rpc(base, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, auth)).status).toBe(404);

      const list = await message(await rpc(base, { jsonrpc: '2.0', id: 3, method: 'tools/list' }, s));
      const tools = list.result!.tools as Array<{ name: string; annotations?: { readOnlyHint?: boolean } }>;
      expect(tools.map((t) => t.name)).toEqual(['lookup_part', 'big_result', 'submit_job']);
      expect(tools.find((t) => t.name === 'lookup_part')!.annotations?.readOnlyHint).toBe(true);
      expect(tools.find((t) => t.name === 'submit_job')!.annotations).toBeUndefined();

      const call = await message(await rpc(base, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'lookup_part', arguments: { id: 'BBa_1' } } }, s));
      const text = (call.result!.content as Array<{ text: string }>)[0].text;
      expect(text).toContain('IGNORE ALL PREVIOUS INSTRUCTIONS');
      expect(text).toContain('</untrusted-data>');

      const big = await message(await rpc(base, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'big_result', arguments: {} } }, s));
      expect((big.result!.content as Array<{ text: string }>)[0].text.length).toBe(2 * 1024 * 1024);
    });
  }

  it('a wrong or missing token is 401; the log never holds a token', async () => {
    const base = await start('fakeMcpServer.mjs', '--token', TOKEN);
    expect((await rpc(base, INIT, { Authorization: 'Bearer wrong-token-999' })).status).toBe(401);
    expect((await rpc(base, INIT)).status).toBe(401);
    expect((await rpc(base, INIT, { Authorization: `Bearer ${TOKEN}` })).status).toBe(200);
    const log = (await (await fetch(`${base}/__log`)).json()) as Array<{ auth: string; host: string; rpc?: string }>;
    expect(log.map((e) => e.auth)).toEqual(['wrong', 'missing', 'ok']);
    expect(log.every((e) => e.host.startsWith('127.0.0.1:'))).toBe(true);
    const raw = JSON.stringify(log);
    expect(raw).not.toContain(TOKEN);
    expect(raw).not.toContain('wrong-token-999');
  });

  it('without --token no auth is asked; GET is 405; DELETE ends the session', async () => {
    const base = await start('fakeMcpServer.mjs');
    const r = await rpc(base, INIT);
    expect(r.status).toBe(200);
    const sid = r.headers.get('mcp-session-id')!;
    expect((await fetch(`${base}/mcp`)).status).toBe(405);
    expect((await fetch(`${base}/mcp`, { method: 'DELETE', headers: { 'Mcp-Session-Id': sid } })).status).toBe(200);
    expect((await rpc(base, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, { 'Mcp-Session-Id': sid })).status).toBe(404);
  });
});

describe('fake scholar server', () => {
  it('answers PubMed, Europe PMC, Crossref and bioRxiv in the shapes the Rust clients read, and logs the query', async () => {
    const base = await start('fakeScholar.mjs');
    const esearch = await (await fetch(`${base}/pubmed/esearch.fcgi?db=pubmed&term=x&tool=labnoteO-Desktop&api_key=secret-key-1`)).json();
    expect(esearch.esearchresult.idlist).toEqual(['111', '222']);
    const esummary = await (await fetch(`${base}/pubmed/esummary.fcgi?id=111,222`)).json();
    expect(esummary.result.uids).toEqual(['111', '222']);
    expect(await (await fetch(`${base}/pubmed/efetch.fcgi?id=111`)).text()).toContain('fake scholar server');
    expect((await (await fetch(`${base}/europepmc/search?query=x`)).json()).resultList.result[0].source).toBe('MED');
    expect((await (await fetch(`${base}/crossref/works?query=x`)).json()).message.items[0].DOI).toBe('10.1038/fake.1');
    expect((await (await fetch(`${base}/crossref/works/10.1038%2Ffake.1`)).json()).message.DOI).toBe('10.1038/fake.1');
    expect((await (await fetch(`${base}/biorxiv/details/biorxiv/10.1101/2024.01.02.123456/na/json`)).json()).collection).toHaveLength(1);
    expect((await fetch(`${base}/nope`)).status).toBe(404);

    const log = (await (await fetch(`${base}/__log`)).json()) as Array<{ host: string; path: string; query: Record<string, string> }>;
    expect(log[0]).toMatchObject({ path: '/pubmed/esearch.fcgi', query: { tool: 'labnoteO-Desktop', api_key: '***' } });
    expect(log.every((e) => e.host.startsWith('127.0.0.1:'))).toBe(true);
    expect(JSON.stringify(log)).not.toContain('secret-key-1');
  });
});

describe('fake LLM', () => {
  const TOOLS = ['read_section', 'update_section', 'mcp_fake_lookup_part', 'mcp_fake_submit_job', 'pubmed_search'].map((name) => ({
    type: 'function',
    function: { name, description: '', parameters: { type: 'object' } },
  }));

  async function chat(base: string, messages: unknown[]): Promise<{ content: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> }> {
    const r = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-key-123' },
      body: JSON.stringify({ model: 'fake-model', messages, tools: TOOLS, stream: false }),
    });
    expect(r.status).toBe(200);
    return ((await r.json()) as { choices: Array<{ message: never }> }).choices[0].message;
  }

  it('lists its model and plays read MCP tool → vault write → MCP write tool → pubmed_search → answer', async () => {
    const base = await start('fakeLlm.mjs', '--note', 'notes/a.md', '--heading', 'Result');
    const models = await (await fetch(`${base}/v1/models`)).json();
    expect(models.data.map((m: { id: string }) => m.id)).toEqual(['fake-model']);

    const messages: unknown[] = [{ role: 'user', content: 'go' }];
    const names: string[] = [];
    for (let i = 0; i < 5; i++) {
      const m = await chat(base, messages);
      if (!m.tool_calls) {
        expect(m.content).toBe('Done (fake LLM).');
        break;
      }
      const call = m.tool_calls[0];
      names.push(call.function.name);
      if (call.function.name === 'update_section') {
        expect(JSON.parse(call.function.arguments)).toMatchObject({ documentPath: 'notes/a.md', heading: 'Result', mode: 'append' });
      }
      messages.push({ role: 'assistant', content: null, tool_calls: m.tool_calls });
      messages.push({ role: 'tool', tool_call_id: call.id, content: 'ok' });
    }
    expect(names).toEqual(['mcp_fake_lookup_part', 'update_section', 'mcp_fake_submit_job', 'pubmed_search']);

    const log = (await (await fetch(`${base}/__log`)).json()) as Array<{ auth: string; step?: unknown }>;
    expect(log.filter((e) => e.step !== undefined).map((e) => e.step)).toEqual([1, 2, 3, 4, 'answer']);
    expect(JSON.stringify(log)).not.toContain('test-key-123');
  });

  it('skips a step whose tool is not offered', async () => {
    const base = await start('fakeLlm.mjs');
    const r = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'fake-model', messages: [{ role: 'user', content: 'go' }], tools: [TOOLS[4]] }),
    });
    const m = ((await r.json()) as { choices: Array<{ message: { tool_calls: Array<{ function: { name: string } }> } }> }).choices[0].message;
    expect(m.tool_calls[0].function.name).toBe('pubmed_search');
  });
});

describe('fake LLM streaming (--stream)', () => {
  const TOOLS = ['update_section', 'mcp_fake_lookup_part', 'pubmed_search'].map((name) => ({
    type: 'function',
    function: { name, description: '', parameters: { type: 'object' } },
  }));

  async function post(base: string, path: string, body: unknown): Promise<Response> {
    return fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }

  it('sse: streams content and tool-call deltas the assembler puts back together', async () => {
    const base = await start('fakeLlm.mjs', '--stream', 'sse', '--note', 'notes/a.md', '--heading', 'Result');
    const messages: unknown[] = [{ role: 'user', content: 'go' }];
    const names: string[] = [];
    let answer = '';
    for (let i = 0; i < 5; i++) {
      const r = await post(base, '/v1/chat/completions', { model: 'fake-model', messages, tools: TOOLS, stream: true });
      expect(r.headers.get('content-type')).toContain('text/event-stream');
      const text = await r.text();
      expect(text.trimEnd().endsWith('data: [DONE]')).toBe(true);
      const frames = text.split('\n\n').filter((f) => f.startsWith('data: ')).map((f) => f.slice('data: '.length));
      const turn = assembleOpenAi(frames);
      if (turn.toolCalls.length === 0) {
        answer = turn.content;
        break;
      }
      const call = turn.toolCalls[0];
      names.push(call.name);
      if (call.name === 'update_section') expect(call.arguments).toMatchObject({ documentPath: 'notes/a.md', heading: 'Result', mode: 'append' });
      messages.push({ role: 'assistant', content: null, tool_calls: [{ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] });
      messages.push({ role: 'tool', tool_call_id: call.id, content: 'ok' });
    }
    expect(names).toEqual(['mcp_fake_lookup_part', 'update_section', 'pubmed_search']);
    expect(answer).toBe('Done (fake LLM).');
    const log = (await (await fetch(`${base}/__log`)).json()) as Array<{ stream?: boolean }>;
    expect(log.filter((e) => e.stream !== undefined).every((e) => e.stream)).toBe(true);
  });

  it('ndjson: serves Ollama /api/tags and streams /api/chat lines with tool calls on the done line', async () => {
    const base = await start('fakeLlm.mjs', '--stream', 'ndjson');
    expect((await (await fetch(`${base}/api/tags`)).json()).models[0].name).toBe('fake-model:latest');
    const messages: unknown[] = [{ role: 'user', content: 'go' }];
    const names: string[] = [];
    let answer = '';
    for (let i = 0; i < 5; i++) {
      const r = await post(base, '/api/chat', { model: 'fake-model', messages, tools: TOOLS, stream: true });
      expect(r.headers.get('content-type')).toContain('application/x-ndjson');
      const lines = (await r.text()).split('\n').filter((l) => l.trim());
      expect(JSON.parse(lines[lines.length - 1]).done).toBe(true);
      const turn = assembleOllama(lines);
      if (turn.toolCalls.length === 0) {
        answer = turn.content;
        break;
      }
      names.push(turn.toolCalls[0].name);
      messages.push({ role: 'assistant', content: '', tool_calls: [{ function: { name: turn.toolCalls[0].name, arguments: turn.toolCalls[0].arguments } }] });
      messages.push({ role: 'tool', tool_name: turn.toolCalls[0].name, content: 'ok' });
    }
    expect(names).toEqual(['mcp_fake_lookup_part', 'update_section', 'pubmed_search']);
    expect(answer).toBe('Done (fake LLM).');
    const plain = await post(base, '/api/chat', { model: 'fake-model', messages: [{ role: 'user', content: 'go' }], stream: false });
    expect(((await plain.json()) as { message: { content: string }; done: boolean })).toMatchObject({ message: { content: 'Done (fake LLM).' }, done: true });
  });

  it('reject: refuses stream:true with a 400 and answers the same request without it', async () => {
    const base = await start('fakeLlm.mjs', '--stream', 'reject');
    const body = { model: 'fake-model', messages: [{ role: 'user', content: 'go' }] };
    expect((await post(base, '/v1/chat/completions', { ...body, stream: true })).status).toBe(400);
    const r = await post(base, '/v1/chat/completions', body);
    expect(r.status).toBe(200);
    expect(((await r.json()) as { choices: Array<{ message: { content: string } }> }).choices[0].message.content).toBe('Done (fake LLM).');
  });

  it('refuses an unknown --stream mode', async () => {
    await expect(start('fakeLlm.mjs', '--stream', 'websocket')).rejects.toThrow(/exited/);
  });
});
