#!/usr/bin/env node
/**
 * Scripted OpenAI-compatible LLM for the real-app check (plan Task 16). TEST HELPER ONLY: never bundled.
 *
 *   node scripts/fakeLlm.mjs [--port 47841] [--note README.md] [--heading Notes]
 *
 * - Binds 127.0.0.1 only. `--port 0` picks a free port; the endpoint is printed on stdout. Point the vault's
 *   OpenAI-compatible endpoint at it (model `fake-model`, key `test-key-123`).
 * - GET /v1/models lists `fake-model`. POST /v1/chat/completions (non-streaming) plays a script, one step per
 *   assistant turn that already called tools in the conversation:
 *     1. the offered tool whose name ends with `lookup_part` (a read-only MCP tool; its result is injection text),
 *     2. `update_section` on `--note` / `--heading`, mode append (a vault write: the app must ask, tainted),
 *     3. the offered tool whose name ends with `submit_job` (an MCP tool without readOnly: the app must ask),
 *     4. `pubmed_search` for "E. coli chassis",
 *     then a plain answer. A step whose tool is not offered is skipped.
 * - GET /__log: the request log (host, path, auth `present`/`missing`, the step played, the tool names offered,
 *   the roles of the messages). Never a header value or message text.
 */
import { createServer } from 'node:http';

function parseArgs(argv) {
  const o = { port: 47841, note: 'README.md', heading: 'Notes' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') o.port = Number(argv[++i]);
    else if (a === '--note') o.note = argv[++i];
    else if (a === '--heading') o.heading = argv[++i];
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!Number.isInteger(o.port) || o.port < 0 || o.port > 65535) throw new Error('--port must be 0..65535');
  return o;
}

const opts = parseArgs(process.argv.slice(2));
const log = [];

const STEPS = [
  { match: (n) => n.endsWith('lookup_part'), args: () => ({ id: 'BBa_K000001' }) },
  {
    match: (n) => n === 'update_section',
    args: () => ({ documentPath: opts.note, heading: opts.heading, mode: 'append', content: 'Line written by the fake LLM (test).' }),
  },
  { match: (n) => n.endsWith('submit_job'), args: () => ({ recipe: 'fake' }) },
  { match: (n) => n === 'pubmed_search', args: () => ({ query: 'E. coli chassis' }) },
];

/** The tool names offered in the request body. */
function offered(body) {
  if (!Array.isArray(body?.tools)) return [];
  return body.tools.map((t) => t?.function?.name).filter((n) => typeof n === 'string');
}

/** How many assistant turns of this conversation already asked for tools. */
function turnsDone(body) {
  if (!Array.isArray(body?.messages)) return 0;
  return body.messages.filter((m) => m?.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0).length;
}

/** The next tool call to make, or undefined for the final answer. */
function nextCall(body) {
  const names = offered(body);
  let skip = turnsDone(body);
  for (let i = 0; i < STEPS.length; i++) {
    const name = names.find(STEPS[i].match);
    if (!name) continue;
    if (skip > 0) {
      skip -= 1;
      continue;
    }
    return { step: i + 1, name, args: STEPS[i].args() };
  }
  return undefined;
}

function readBody(req) {
  return new Promise((res, rej) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => res(Buffer.concat(chunks).toString('utf8')));
    req.on('error', rej);
  });
}

let callSeq = 0;

const server = createServer(async (req, res) => {
  const path = (req.url ?? '/').split('?')[0];
  const json = (status, value) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(value));
  if (path === '/__log' && req.method === 'GET') return json(200, log);
  const entry = { host: req.headers.host ?? '', method: req.method, path, auth: req.headers.authorization ? 'present' : 'missing' };
  log.push(entry);
  if (path === '/v1/models' && req.method === 'GET') return json(200, { object: 'list', data: [{ id: 'fake-model', object: 'model' }] });
  if (path !== '/v1/chat/completions' || req.method !== 'POST') return json(404, { error: { message: 'not found' } });
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return json(400, { error: { message: 'bad json' } });
  }
  entry.tools = offered(body);
  entry.roles = Array.isArray(body?.messages) ? body.messages.map((m) => m?.role) : [];
  const call = nextCall(body);
  entry.step = call ? call.step : 'answer';
  const message = call
    ? {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: `call_${++callSeq}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }],
      }
    : { role: 'assistant', content: 'Done (fake LLM).' };
  return json(200, {
    id: `chatcmpl-fake-${callSeq}`,
    object: 'chat.completion',
    model: 'fake-model',
    choices: [{ index: 0, message, finish_reason: call ? 'tool_calls' : 'stop' }],
  });
});

server.listen(opts.port, '127.0.0.1', () => {
  const { port } = server.address();
  process.stdout.write(`fake LLM on http://127.0.0.1:${port}/v1\n`);
});

const stop = () => server.close(() => process.exit(0));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
