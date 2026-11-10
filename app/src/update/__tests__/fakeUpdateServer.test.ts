import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';

/** scripts/fakeUpdateServer.mjs: 127.0.0.1 에서만 듣고, 설치 파일이 아닌 바이트만 준다 (spec §3.7). */
const SCRIPT = resolve('scripts/fakeUpdateServer.mjs');
const running: ChildProcess[] = [];

async function start(...flags: string[]): Promise<string> {
  const child = spawn(process.execPath, [SCRIPT, '--port', '0', ...flags], { stdio: ['ignore', 'pipe', 'pipe'] });
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

describe('fake update server', () => {
  it('serves latest.json for both Windows platforms, pointing at its own payload, with a well-formed wrong signature', async () => {
    const base = await start();
    const r = await fetch(`${base}/latest.json`);
    expect(r.status).toBe(200);
    const j = (await r.json()) as { version: string; platforms: Record<string, { url: string; signature: string }> };
    expect(j.version).toBe('0.1.1');
    expect(Object.keys(j.platforms).sort()).toEqual(['windows-x86_64', 'windows-x86_64-nsis']);
    for (const p of Object.values(j.platforms)) {
      expect(p.url).toBe(`${base}/payload.bin`);
      const sig = Buffer.from(p.signature, 'base64').toString('utf8');
      expect(sig).toMatch(/^untrusted comment: /);
      expect(sig).toContain('trusted comment: ');
    }
  });

  it('streams a chunked payload with Content-Length that is never an installer', async () => {
    const base = await start();
    const r = await fetch(`${base}/payload.bin`);
    expect(r.status).toBe(200);
    const len = Number(r.headers.get('content-length'));
    const body = Buffer.from(await r.arrayBuffer());
    expect(body.length).toBe(len);
    expect(body.length).toBeGreaterThan(16 * 1024);
    expect(body.subarray(0, 20).toString('latin1')).toBe('LABNOTEO-FAKE-UPDATE');
    expect(body.subarray(0, 2).toString('latin1')).not.toBe('MZ');
    expect(body.subarray(0, 2).toString('latin1')).not.toBe('PK');
    expect(body.subarray(0, 8).toString('hex')).not.toBe('d0cf11e0a1b11ae1');
  });

  it('--no-length leaves the size out', async () => {
    const base = await start('--no-length');
    const r = await fetch(`${base}/payload.bin`);
    expect(r.headers.get('content-length')).toBeNull();
    const body = Buffer.from(await r.arrayBuffer());
    expect(body.subarray(0, 20).toString('latin1')).toBe('LABNOTEO-FAKE-UPDATE');
  });

  it('--fail-first answers 500 once, then the payload', async () => {
    const base = await start('--fail-first');
    expect((await fetch(`${base}/payload.bin`)).status).toBe(500);
    const r = await fetch(`${base}/payload.bin`);
    expect(r.status).toBe(200);
    expect(Buffer.from(await r.arrayBuffer()).subarray(0, 20).toString('latin1')).toBe('LABNOTEO-FAKE-UPDATE');
  });

  it('other paths are 404', async () => {
    const base = await start();
    expect((await fetch(`${base}/nope`)).status).toBe(404);
  });
});
