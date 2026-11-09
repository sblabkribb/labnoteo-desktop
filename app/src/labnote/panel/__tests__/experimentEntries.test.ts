import { createFakeVault } from '../../../__tests__/fakeVault';
import { TauriLabnoteFs } from '../../../fs/tauriLabnoteFs';
import { ExperimentEntryCache, readExperimentEntry } from '../experimentEntries';
import { filterExperiments } from '@labnoteo/core';
import { readme } from './panelFixtures';

type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

const A = 'labnote/001_A';
const B = 'labnote/002_B';

describe('readExperimentEntry', () => {
  it('readExperimentEntry reads title/status/discuss/progress/retryOf from a MemFileSystem vault', async () => {
    const vault = createFakeVault({
      [`${A}/README.labnote.md`]: readme('첫 실험', 'failed'),
      [`${B}/README.labnote.md`]: readme(
        '다시',
        'in-progress',
        'discuss: true\nretry_of: "[[labnote/001_A/README.labnote|001]]"\n',
        '- [x] [WD010 Design](./001_WD010_Design.labnote.md)\n- [ ] [WB010 Build](./002_WB010_Build.labnote.md)\n',
      ),
      [`${B}/001_WD010_Design.labnote.md`]: '# d\n',
      [`${B}/002_WB010_Build.labnote.md`]: '# b\n',
    });
    const fs = new TauriLabnoteFs(vault.invoke);
    const e = await readExperimentEntry(fs, B);
    expect(e).toMatchObject({
      folder: B,
      title: '다시',
      status: 'in-progress',
      discuss: true,
      lastUpdated: '2026-02-03',
      project: '단백질',
      authors: ['김연구', '이연구'],
      progress: { done: 1, total: 2 },
      workflowNames: ['001 WD010 Design', '002 WB010 Build'],
      markers: 0,
      retryOf: A,
    });
    expect(e.frontMatterError).toBeUndefined();
    expect((await readExperimentEntry(fs, A, 3)).markers).toBe(3);
  });

  it('reads created_date, so the core search finds an experiment by the day it was made (#515)', async () => {
    const vault = createFakeVault({
      [`${A}/README.labnote.md`]: readme('A', 'in-progress', 'created_date: 2025-12-24\n'),
      [`${B}/README.labnote.md`]: readme('B', 'in-progress', 'created_date: "  "\n'),
    });
    const fs = new TauriLabnoteFs(vault.invoke);
    const a = await readExperimentEntry(fs, A);
    const b = await readExperimentEntry(fs, B);
    expect(a.created).toBe('2025-12-24');
    expect(b.created).toBeUndefined();
    expect(filterExperiments([a, b], '2025-12-24').map((e) => e.folder)).toEqual([A]);
  });

  it('progress counts only checklist entries whose note exists, and a note listed twice once', async () => {
    const vault = createFakeVault({
      [`${A}/README.labnote.md`]: readme(
        'A',
        'in-progress',
        '',
        [
          '- [x] [WD010 Design](./001_WD010_Design.labnote.md)',
          '- [ ] [WD010 Design again](./001_WD010_Design.labnote.md)',
          '- [ ] [Moved away](./002_WB010_Gone.labnote.md)',
          '- [x] [Elsewhere](shared/003_WT010_Test.labnote.md)',
          '',
        ].join('\n'),
      ),
      [`${A}/001_WD010_Design.labnote.md`]: '# d\n',
      'shared/003_WT010_Test.labnote.md': '# t\n',
    });
    const e = await readExperimentEntry(new TauriLabnoteFs(vault.invoke), A);
    // 첫 항목(체크됨)만 001 로 센다. 없는 노트는 세지 않는다. 폴더 밖 링크 경로의 노트는 센다.
    expect(e.progress).toEqual({ done: 2, total: 2 });
  });

  it('two checklist links that differ only in case are one note (Windows) and count once', async () => {
    const vault = createFakeVault({
      [`${A}/README.labnote.md`]: readme(
        'A',
        'in-progress',
        '',
        ['- [x] [Design](./001_WD010_Design.labnote.md)', '- [ ] [design](./001_wd010_design.labnote.md)', ''].join('\n'),
      ),
      [`${A}/001_WD010_Design.labnote.md`]: '# d\n',
    });
    const e = await readExperimentEntry(new TauriLabnoteFs(vault.invoke), A);
    expect(e.progress).toEqual({ done: 1, total: 1 });
  });

  it('a CRLF + BOM README parses', async () => {
    const text = `﻿${readme('윈도', 'completed', 'discuss: true\n', '- [x] [WD010 Design](./001_WD010_Design.labnote.md)\n')}`.replace(
      /\n/g,
      '\r\n',
    );
    const vault = createFakeVault({
      [`${A}/README.labnote.md`]: text,
      [`${A}/001_WD010_Design.labnote.md`]: '# d\r\n',
    });
    const e = await readExperimentEntry(new TauriLabnoteFs(vault.invoke), A);
    expect(e).toMatchObject({ title: '윈도', status: 'completed', discuss: true, progress: { done: 1, total: 1 } });
    expect(e.frontMatterError).toBeUndefined();
  });
});

/** vault_read 를 늦추고, 동시에 몇 개가 진행 중인지 잰다. */
function slowReads(invoke: InvokeFn, ms = 5) {
  let inFlight = 0;
  let max = 0;
  const reads: string[] = [];
  const wrapped = (async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd !== 'vault_read') return invoke(cmd, args);
    reads.push(String(args?.path));
    inFlight++;
    max = Math.max(max, inFlight);
    try {
      await new Promise((r) => setTimeout(r, ms));
      return await invoke(cmd, args);
    } finally {
      inFlight--;
    }
  }) as InvokeFn;
  return { invoke: wrapped, reads, max: () => max, reset: () => ((max = 0), (reads.length = 0)) };
}

describe('ExperimentEntryCache', () => {
  function bigVault() {
    const files: Record<string, string> = {};
    for (let i = 1; i <= 10; i++) {
      const dir = `labnote/${String(i).padStart(3, '0')}_E${i}`;
      files[`${dir}/README.labnote.md`] = readme(`E${i}`, 'in-progress');
      files[`${dir}/001_WD010_Design.labnote.md`] = i % 2 ? '# d\n\n결과 @issue;ISS-a1;수율 논의\n' : '# d\n';
      files[`${dir}/002_WB010_Build.labnote.md`] = '# b\n';
    }
    return createFakeVault(files);
  }

  it('first render reads no workflow-note bodies; marker counts arrive afterwards with at most 4 experiments in flight', async () => {
    const vault = bigVault();
    const slow = slowReads(vault.invoke);
    const cache = new ExperimentEntryCache(new TauriLabnoteFs(slow.invoke));
    const first = await cache.all();
    expect(first).toHaveLength(10);
    expect(first.every((e) => e.markers === 0)).toBe(true);
    expect(slow.reads.length).toBeGreaterThan(0);
    expect(slow.reads.every((p) => p.endsWith('/README.labnote.md'))).toBe(true);

    slow.reset();
    const counts = new Map<string, number>();
    await new Promise<void>((done) => {
      cache.countMarkers((folder, n) => {
        counts.set(folder, n);
        if (counts.size === 10) done();
      });
    });
    expect(slow.max()).toBe(4);
    expect(counts.get('labnote/001_E1')).toBe(1);
    expect(counts.get('labnote/002_E2')).toBe(0);
    // 센 값은 다음 all() 에 들어 있고, 다시 읽지 않는다
    slow.reset();
    const again = await cache.all();
    expect(again.find((e) => e.folder === 'labnote/003_E3')?.markers).toBe(1);
    expect(slow.reads).toEqual([]);
  });

  it("invalidate('labnote/001_A/x.labnote.md') re-reads only 001_A", async () => {
    const vault = createFakeVault({
      [`${A}/README.labnote.md`]: readme('A', 'planned'),
      [`${B}/README.labnote.md`]: readme('B', 'planned'),
    });
    const slow = slowReads(vault.invoke, 0);
    const cache = new ExperimentEntryCache(new TauriLabnoteFs(slow.invoke));
    await cache.all();
    slow.reset();
    await vault.mem.write(`${A}/README.labnote.md`, readme('A2', 'completed'));
    cache.invalidate([`${A}/x.labnote.md`]);
    const entries = await cache.all();
    expect(slow.reads).toEqual([`${A}/README.labnote.md`]);
    expect(entries.find((e) => e.folder === A)).toMatchObject({ title: 'A2', status: 'completed' });

    slow.reset();
    cache.invalidate('all');
    await cache.all();
    expect([...slow.reads].sort()).toEqual([`${A}/README.labnote.md`, `${B}/README.labnote.md`]);
  });

  it('a numbered folder without a README is not an experiment, and retries are linked', async () => {
    const vault = createFakeVault({
      [`${A}/README.labnote.md`]: readme('A', 'failed'),
      [`${B}/README.labnote.md`]: readme('B', 'planned', 'retry_of: "[[labnote/001_A/README.labnote|001]]"\n'),
      'labnote/003_Empty/notes.md': '',
    });
    const entries = await new ExperimentEntryCache(new TauriLabnoteFs(vault.invoke)).all();
    expect(entries.map((e) => e.folder)).toEqual([A, B]);
    expect(entries[0].retriedBy).toEqual([B]);
  });
});
