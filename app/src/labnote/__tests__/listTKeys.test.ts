/**
 * scripts/listTKeys.mjs: 플러그인 소스의 줄 범위에서 t() 키를 뽑고 l10n.ko.ts 에 있는지 알려 준다.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import obsidianKo from '../../../vendor/labnoteo/src/l10n.ko';

type Row = { key: string; inKo: boolean };
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

  it('exits 2 on bad arguments', () => {
    expect(run().status).toBe(2);
    expect(run('vendor/labnoteo/src/partbank/partbankSearch.ts', '5', '2').status).toBe(2);
  });
});
