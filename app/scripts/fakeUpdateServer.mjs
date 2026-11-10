#!/usr/bin/env node
/**
 * Fake update server for the updater check (spec §3.7). TEST HELPER ONLY: never bundled, never used by a release.
 *
 *   node scripts/fakeUpdateServer.mjs --port 47811 [--no-length] [--fail-first] [--slow] [--signature <file>]
 *
 * - Binds 127.0.0.1 only. `--port 0` picks a free port; the chosen URL is printed on stdout.
 * - GET /latest.json: version 0.1.1 for windows-x86_64 and windows-x86_64-nsis, both pointing at /payload.bin.
 *   The signature is the content of `--signature <file>` (a `tauri signer sign` .sig), or a well-formed but WRONG one.
 * - GET /payload.bin: plain bytes starting with `LABNOTEO-FAKE-UPDATE`, streamed in chunks. It is never an installer
 *   (no MZ / PK / MSI magic): even a correctly signed payload fails to extract, so nothing is ever launched.
 *   `--no-length` leaves out Content-Length, `--fail-first` answers 500 to the first payload request, `--slow` streams slowly.
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

const MAGIC = 'LABNOTEO-FAKE-UPDATE';
const PAYLOAD_BYTES = 256 * 1024;
const CHUNK_BYTES = 16 * 1024;

function parseArgs(argv) {
  const o = { port: 47811, noLength: false, failFirst: false, slow: false, signature: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') o.port = Number(argv[++i]);
    else if (a === '--no-length') o.noLength = true;
    else if (a === '--fail-first') o.failFirst = true;
    else if (a === '--slow') o.slow = true;
    else if (a === '--signature') o.signature = argv[++i];
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!Number.isInteger(o.port) || o.port < 0 || o.port > 65535) throw new Error('--port must be 0..65535');
  return o;
}

/** Bytes that start with the magic and can never be mistaken for an exe, zip or msi. */
export function fakePayload(size = PAYLOAD_BYTES) {
  const buf = Buffer.alloc(size, 0x2e); // '.'
  buf.write(`${MAGIC}\n`, 0, 'latin1');
  return buf;
}

/** A minisign-shaped signature (base64 of the .sig text) that does not verify against any real key. */
export function wrongSignature() {
  const sig = Buffer.concat([Buffer.from('Ed', 'latin1'), Buffer.alloc(8, 0x11), Buffer.alloc(64, 0x22)]).toString('base64');
  const global = Buffer.alloc(64, 0x33).toString('base64');
  const text =
    'untrusted comment: signature from labnoteO fake update server (not valid)\n' +
    `${sig}\n` +
    'trusted comment: timestamp:0\tfile:payload.bin\n' +
    `${global}\n`;
  return Buffer.from(text, 'utf8').toString('base64');
}

const opts = parseArgs(process.argv.slice(2));
const signature = opts.signature ? readFileSync(opts.signature, 'utf8').trim() : wrongSignature();
const payload = fakePayload();
let payloadRequests = 0;

const server = createServer((req, res) => {
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  const path = (req.url ?? '/').split('?')[0];
  if (req.method !== 'GET') {
    res.writeHead(405).end();
    return;
  }
  if (path === '/latest.json') {
    const entry = { signature, url: `${base}/payload.bin` };
    const body = JSON.stringify({
      version: '0.1.1',
      notes: 'labnoteO fake update (test only)',
      pub_date: '2026-11-10T00:00:00Z',
      platforms: { 'windows-x86_64': entry, 'windows-x86_64-nsis': entry },
    });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(body);
    return;
  }
  if (path === '/payload.bin') {
    payloadRequests += 1;
    if (opts.failFirst && payloadRequests === 1) {
      res.writeHead(500, { 'Content-Type': 'text/plain' }).end('fake failure');
      return;
    }
    const headers = { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' };
    if (!opts.noLength) headers['Content-Length'] = String(payload.length);
    res.writeHead(200, headers);
    const delay = opts.slow ? 250 : 2;
    let offset = 0;
    const next = () => {
      if (res.destroyed) return;
      if (offset >= payload.length) {
        res.end();
        return;
      }
      const end = Math.min(offset + CHUNK_BYTES, payload.length);
      res.write(payload.subarray(offset, end));
      offset = end;
      setTimeout(next, delay);
    };
    next();
    return;
  }
  res.writeHead(404).end();
});

server.listen(opts.port, '127.0.0.1', () => {
  const { port } = server.address();
  process.stdout.write(`fake update server on http://127.0.0.1:${port}\n`);
});

const stop = () => server.close(() => process.exit(0));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
