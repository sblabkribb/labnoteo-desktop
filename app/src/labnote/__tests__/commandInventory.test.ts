/**
 * 명령 목록: 앱이 등록한 명령과 플러그인이 등록하는 명령을 맞춰 본다.
 * - SP2 가 옮긴 명령은 registerAllCommands() 뒤에 모두 있고, 그 id 는 플러그인 main.ts 에 그대로 있다.
 * - 플러그인의 나머지 명령은 모두 DEFERRED 에 그 하위 프로젝트와 함께 적혀 있다. 남은 이식이 보이고,
 *   플러그인에 새 명령이 생기면(vendor 동기화) 이 테스트가 빨갛게 된다.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { clearCommandsForTest, commands } from '../commands/registry';
import { registerAllCommands } from '../commands/registerAll';

const VENDOR_SRC = 'vendor/labnoteo/src';
const SOURCES = ['main.ts', 'barcode/barcodeFeature.ts'];

/** SP2 가 등록하는 플러그인 명령. */
const PORTED = [
  'create-experiment',
  'create-workflow',
  'insert-unit-operation',
  'change-experiment-status',
  'retry-experiment',
  'toggle-discussion-flag',
  'insert-date',
  'insert-datetime',
  'insert-issue-marker',
  'update-catalogs',
  'sync-workflow-checklist',
  'open-workflow-view',
  'insert-experiment-samples-table',
  'open-sample-definition',
  'open-sample-view',
  'download-partbank-catalog',
] as const;

/** 아직 옮기지 않은 플러그인 명령과 그것을 옮길 하위 프로젝트(계획의 "Deferred to later sub-projects"). */
const DEFERRED: Record<string, string> = {
  'setup-research-automation': 'exports and automation',
  'export-tables-csv': 'exports and automation',
  'export-experiment-tables-csv': 'exports and automation',
  'open-user-guide': 'exports and automation',
  'renumber-workflows':
    'rename and links: must call queueSampleSourceRenames after the README hold is released (vendor tests/plugin/renumberWorkflows.test.ts "sample sources after renumbering", #149)',
  'refresh-partbank-locations': 'platform and integrations',
  'ai-draft-method': 'platform and integrations',
  'ai-summarize-results': 'platform and integrations',
  'ai-summarize-experiment': 'platform and integrations',
  'ai-extract-samples': 'platform and integrations',
  'ai-ask-agent': 'platform and integrations',
  'toggle-mcp-server': 'platform and integrations',
  'show-note-barcode': 'barcode',
  'assign-note-id': 'barcode',
  'print-experiment-worksheet': 'barcode',
  'print-whole-note': 'barcode',
  'import-scanned-pages': 'barcode',
  'process-scan-folder': 'barcode',
  'assign-unmatched-scans': 'barcode',
};

/** 플러그인 소스에서 `id: '<id>'` 로 등록하는 명령 id(중복 없이). */
function vendorIds(): Set<string> {
  const ids = new Set<string>();
  for (const file of SOURCES) {
    const text = readFileSync(join(VENDOR_SRC, file), 'utf8');
    for (const m of text.matchAll(/\bid:\s*'([a-z0-9-]+)'/g)) ids.add(m[1]);
  }
  return ids;
}

afterEach(() => clearCommandsForTest());

describe('명령 목록(플러그인과 맞춰 보기)', () => {
  it('every SP2 command id is registered after registerAllCommands()', () => {
    registerAllCommands();
    const registered = new Set(commands().map((c) => c.id));
    expect(PORTED.filter((id) => !registered.has(id))).toEqual([]);
  });

  it('every registered id exists in vendor main.ts', () => {
    registerAllCommands();
    const main = readFileSync(join(VENDOR_SRC, 'main.ts'), 'utf8');
    const missing = commands()
      .map((c) => c.id)
      .filter((id) => !main.includes(`id: '${id}'`));
    expect(missing).toEqual([]);
  });

  it('every other vendor command id is listed in DEFERRED with its sub-project', () => {
    registerAllCommands();
    const registered = new Set(commands().map((c) => c.id));
    const unaccounted = [...vendorIds()].filter((id) => !registered.has(id) && !(id in DEFERRED));
    expect(unaccounted).toEqual([]);
  });

  it('DEFERRED names only vendor commands that are not registered (no stale entries)', () => {
    registerAllCommands();
    const ids = vendorIds();
    const registered = new Set(commands().map((c) => c.id));
    expect(Object.keys(DEFERRED).filter((id) => !ids.has(id) || registered.has(id))).toEqual([]);
    expect(Object.values(DEFERRED).every((s) => s.trim() !== '')).toBe(true);
  });

  it('the renumber-workflows note names the sample source hook it must call (SP5 D2, #149)', async () => {
    expect(DEFERRED['renumber-workflows']).toContain('must call queueSampleSourceRenames after the README hold is released');
    const ledger = await import('../port/sampleLedger');
    expect(typeof ledger.queueSampleSourceRenames).toBe('function');
  });
});
