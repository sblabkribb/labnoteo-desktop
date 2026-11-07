/** 샘플 테스트들이 함께 쓰는 보관함과 상수(계획의 Shared test fixture). Task 15 가 koListHeader 를 더한다. */
/**
 * `KnownSampleIds`(Task 5 의 SampleIdIndex 포트)와 같은 꼴. 그 포트가 들어오기 전이라 여기서 구조로 적는다:
 * 구조가 같으므로 Task 5 의 타입에 그대로 맞는다.
 */
interface KnownIds {
  ids: ReadonlySet<string>;
  aliases: ReadonlyMap<string, string>;
  discarded: ReadonlyMap<string, string>;
  version: number;
}

export const README = '---\ntitle: 061 PCR\nsample_tracking: yes\n---\n# 061 PCR\n';
export const SAMPLE_VAULT: Record<string, string> = {
  'labnote/061_PCR/README.labnote.md': README,
  'labnote/061_PCR/001_clone.labnote.md': '# clone\n\n@dna;DNA-1;pUC;miniprep\n\nUse DNA-1;pUC and Reagent-7.\n',
  'labnote/061_PCR/resources/labsamples/DNA.json':
    '{"DNA-1":{"type":"DNA","alias":"pUC","descriptions":["miniprep"],"sources":["001_clone"],"location":"Freezer A / B3"}}',
  'labnote/062_Gel/README.labnote.md': README.replace('061 PCR', '062 Gel').replace('yes', 'no'),
  'labnote/062_Gel/001_run.labnote.md': '# run\n\nDNA-1\n',
  'resources/labsamples/Reagent.json':
    '{"Reagent-7":{"type":"Reagent","alias":"Taq","descriptions":["polymerase"],"sources":["001_clone"],"discarded":"2026-10-01"}}',
  'resources/labsamples/Reagent_vendor.json': '{"Reagent-900":{"type":"Reagent","alias":"dNTP","descriptions":["mix"],"sources":[]}}',
  'Home.md': '# Home\n',
};
export const NOTE = 'labnote/061_PCR/001_clone.labnote.md';
export const LOCAL = 'labnote/061_PCR/resources/labsamples';
export const GLOBAL = 'resources/labsamples';
export const CONFLICTED = '<<<<<<< HEAD\n{}\n=======\n{}\n>>>>>>> b\n';
export const KNOWN: KnownIds = {
  ids: new Set(['dna-1', 'reagent-7', 'reagent-900']),
  aliases: new Map([['dna-1', 'pUC'], ['reagent-7', 'Taq']]),
  discarded: new Map([['reagent-7', '2026-10-01']]),
  version: 1,
};
export const KNOWN_WITH_DNA9: KnownIds = { ...KNOWN, ids: new Set([...KNOWN.ids, 'dna-9']), version: 2 };
