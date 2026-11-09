/**
 * scripts/listTKeys.mjs: 플러그인 소스의 줄 범위에서 t() 키를 뽑고 l10n.ko.ts 에 있는지 알려 준다.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import obsidianKo from '../../../vendor/labnoteo/src/l10n.ko';

type Row = { key: string; inKo: boolean; dynamic?: true };
const run = (...args: string[]) => spawnSync('node', ['scripts/listTKeys.mjs', ...args], { encoding: 'utf-8' });

describe('scripts/listTKeys.mjs', () => {
  it('listTKeys finds the partbank search keys with ko', () => {
    const out = JSON.parse(
      execFileSync('node', ['scripts/listTKeys.mjs', 'vendor/labnoteo/src/partbank/partbankSearch.ts', '132', '150']).toString(),
    );
    expect(out).toContainEqual({ key: 'Only the first {0} of each type are shown ({1}). Type more to narrow the search.', inKo: true });
  });

  it('inKo agrees with the l10n.ko.ts object for a whole vendor file', () => {
    const r = run('vendor/labnoteo/src/partbank/partbankSearch.ts', '1', '271');
    const out = JSON.parse(r.stdout) as Row[];
    expect(out.length).toBeGreaterThan(3);
    for (const row of out) expect(row.inKo).toBe(Object.hasOwn(obsidianKo, row.key));
  });

  it('reports this.t / plugin.t / host.t, multi-line ternaries, and exits 1 on a key without ko', () => {
    const dir = mkdtempSync(join(tmpdir(), 'listtkeys-'));
    const f = join(dir, 'x.ts');
    writeFileSync(
      f,
      [
        "const a = format('not a key');",
        "this.t('Cancel');",
        'plugin.t(',
        "  gone ? 'No such key in ko, surely.' : 'Cancel'",
        ');',
        "host.t('Cancel', 1);",
        "other.t('Ignored, other receiver.');",
        "t('Outside the range.');",
      ].join('\n'),
    );
    const r = run(f, '1', '7');
    expect(r.status).toBe(1);
    expect(JSON.parse(r.stdout)).toEqual([
      { key: 'Cancel', inKo: Object.hasOwn(obsidianKo, 'Cancel') },
      { key: 'No such key in ko, surely.', inKo: false },
    ]);
  });

  it('--ko-keys reads every key of l10n.ko.ts, quoted or bare', () => {
    const r = run('--ko-keys');
    expect(r.status).toBe(0);
    const keys = JSON.parse(r.stdout) as string[];
    const want = Object.keys(obsidianKo);
    expect(keys.filter((k) => !Object.hasOwn(obsidianKo, k))).toEqual([]); // 없는 키를 읽지 않는다
    expect(want.filter((k) => !keys.includes(k))).toEqual([]); // 있는 키를 빠뜨리지 않는다
    expect(keys.length).toBe(want.length);
    expect(keys).toContain('Undo');
  });

  it('finds bare-identifier ko keys and reports first arguments without a literal as dynamic', () => {
    const dir = mkdtempSync(join(tmpdir(), 'listtkeys-'));
    const f = join(dir, 'x.ts');
    writeFileSync(f, ["this.t('Undo');", "t('Details');", 't(KEY);', 't(`tpl ${x}`);', "t('Two\\n\\nlines \\'q\\'');"].join('\n'));
    const r = run(f, '1', '5');
    expect(r.status).toBe(1);
    expect(JSON.parse(r.stdout)).toEqual([
      { key: 'Undo', inKo: true },
      { key: 'Details', inKo: true },
      { key: 'KEY', inKo: false, dynamic: true },
      { key: '`tpl ${x}`', inKo: false, dynamic: true },
      { key: "Two\n\nlines 'q'", inKo: false }, // \n 은 줄바꿈으로 푼다(n 이 아니다)
    ]);
  });

  it('exits 2 on bad arguments', () => {
    expect(run().status).toBe(2);
    expect(run('vendor/labnoteo/src/partbank/partbankSearch.ts', '5', '2').status).toBe(2);
  });
});
