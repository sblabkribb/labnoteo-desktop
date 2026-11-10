import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 가짜 업데이트 서버(127.0.0.1)로 시험하는 설정 덧씌우기는 시험용 exe 에만 쓴다 (spec §3.7).
 * 출시 설정이 http/루프백 주소나 dangerous* 키를 갖거나, 빌드 스크립트·워크플로가 덧씌우기를 쓰면 안 된다.
 */
const read = (p: string) => readFileSync(p, 'utf-8');
const json = (p: string) => JSON.parse(read(p)) as Record<string, unknown>;

function keys(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) v.forEach((x) => keys(x, out));
  else if (v && typeof v === 'object')
    for (const [k, x] of Object.entries(v)) {
      out.push(k);
      keys(x, out);
    }
  return out;
}

const LOOPBACK = /127\.0\.0\.1|localhost|\[::1\]/i;
type Updater = { endpoints?: string[]; pubkey?: string; dangerousInsecureTransportProtocol?: boolean };
const updaterOf = (c: Record<string, unknown>) => ((c.plugins as Record<string, unknown> | undefined)?.updater ?? {}) as Updater;

describe('updater config', () => {
  it.each(['src-tauri/tauri.conf.json', 'src-tauri/tauri.release.conf.json'])('%s has no dangerous* key and no loopback endpoint', (p) => {
    const c = json(p);
    expect(keys(c).filter((k) => /^dangerous/i.test(k))).toEqual([]);
    for (const e of updaterOf(c).endpoints ?? []) {
      expect(e).toMatch(/^https:\/\//);
      expect(e).not.toMatch(LOOPBACK);
    }
  });

  it('no package.json script and no workflow names the test overlay', () => {
    const pkg = json('package.json') as { scripts?: Record<string, string> };
    for (const s of Object.values(pkg.scripts ?? {})) expect(s).not.toContain('tauri.test.conf.json');
    for (const wf of ['ci.yml', 'release.yml', 'sync-core.yml']) expect(read(join('..', '.github', 'workflows', wf))).not.toContain('tauri.test.conf.json');
  });

  it('the test overlay uses the test identifier, loopback endpoints only, and no pubkey', () => {
    const c = json('src-tauri/tauri.test.conf.json');
    expect(c.identifier).toBe('kr.sblab.labnoteo.test');
    const u = updaterOf(c);
    expect(u.endpoints).toEqual(['http://127.0.0.1:47811/latest.json']);
    for (const e of u.endpoints ?? []) expect(e).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//);
    expect(u.dangerousInsecureTransportProtocol).toBe(true);
    expect(u.pubkey).toBeUndefined();
    // 덧씌우기는 이것만 바꾼다: CSP·창·번들은 출시 설정 그대로
    expect(Object.keys(c).filter((k) => k !== '$schema').sort()).toEqual(['identifier', 'plugins']);
  });
});
