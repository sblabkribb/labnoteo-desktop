/**
 * app/vendor/labnoteo/tests/plugin/pickRank.test.ts 의 사례를 옮겼다(#324, #401, #485, #537).
 * 한글 이름을 치면 설명에만 그 말이 있는 항목보다 그 이름의 항목이 먼저 오고, 띄어쓰기를 빼도 찾는다.
 */
import type { PickItem } from '@labnoteo/core';
import { rankPickItems, withSelectedFirst } from '../port/rankPickItems';
import { catalogKoFields } from '../port/aliasHints';
import workflows from '../../../vendor/labnoteo/packages/labnoteo-core/src/catalog/workflows_en.json';
import hw from '../../../vendor/labnoteo/packages/labnoteo-core/src/catalog/unitoperations_hw_en.json';

const op = (id: string, name: string, ko: string, detail: string): PickItem<string> => ({
  label: `${id}: ${name}`,
  description: `${ko} · Hardware`,
  detail,
  keywords: [ko],
  value: id,
});

const ITEMS = [
  op('UHW060', 'Colony Picking', '콜로니 피킹', '액체 배양으로 옮길 콜로니를 고릅니다.'),
  op('UHW130', 'Sealing', '실링', 'PCR, 배양 전에 플레이트를 밀봉합니다.'),
  op('UHW180', 'Incubation', '배양', '정해진 온도에서 키웁니다.'),
  op('UHW190', 'Fermentation', '발효 배양', '발효조에서 키웁니다.'),
];

describe('rankPickItems matches Korean keywords and ignores spaces', () => {
  it('puts an exact Korean name first, ahead of items only describing it', () => {
    expect(rankPickItems(ITEMS, '배양').map((i) => i.value)).toEqual(['UHW180', 'UHW190', 'UHW060', 'UHW130']);
  });

  it('ranks a label word, then the label, ahead of descriptions', () => {
    expect(rankPickItems(ITEMS, 'incubation')[0].value).toBe('UHW180');
    expect(rankPickItems(ITEMS, 'uhw1').map((i) => i.value)).toEqual(['UHW130', 'UHW180', 'UHW190']);
  });

  it('ranks an English description kept as a keyword with the detail', () => {
    const items: PickItem<string>[] = [
      { label: 'A: Plating', keywords: ['플레이팅', 'Spread cells on agar for culture'], value: 'A' },
      { label: 'B: Incubation', keywords: ['culture'], value: 'B' },
    ];
    expect(rankPickItems(items, 'culture').map((i) => i.value)).toEqual(['B', 'A']);
  });

  it('keeps the given order for an empty query and drops what does not match', () => {
    expect(rankPickItems(ITEMS, '  ').map((i) => i.value)).toEqual(['UHW060', 'UHW130', 'UHW180', 'UHW190']);
    expect(rankPickItems(ITEMS, '원심')).toEqual([]);
  });

  it('finds a query typed without spaces or with its words reordered, last', () => {
    const items = [
      op('UHW100', 'Enzyme Activity Assay', '효소 활성 측정', ''),
      op('UHW200', 'Primer Design', '프라이머 설계', ''),
      op('USW300', 'Data Analysis', '데이터 분석', ''),
      op('UHW400', 'The Access Check', '접근 확인', ''),
    ];
    const found = (q: string) => rankPickItems(items, q).map((i) => i.value);
    expect(found('효소활성')).toEqual(['UHW100']);
    expect(found('프라이머설계')).toEqual(['UHW200']);
    expect(found('데이터분석')).toEqual(['USW300']);
    expect(found('primerdesign')).toEqual(['UHW200']);
    expect(found('activity enzyme')).toEqual(['UHW100']);
    expect(found('측정 효소')).toEqual(['UHW100']);
    expect(found('eac')).toEqual([]);
  });

  it('keeps those matches after the ones found as typed', () => {
    const items = [
      op('UHW100', 'Enzyme Activity Assay', '효소 활성 측정', ''),
      op('UHW110', 'Enzymeactivity Prep', '효소활성 준비', ''),
    ];
    expect(rankPickItems(items, '효소활성').map((i) => i.value)).toEqual(['UHW110', 'UHW100']);
  });

  it('finds words spread over the name and the detail, after every other match', () => {
    const items = [
      op('UHW380', 'Enzyme Activity', '효소 활성', '기질을 넣고 흡광도로 활성을 측정합니다.'),
      op('UHW100', 'Enzyme Activity Assay', '효소 활성 측정', ''),
      op('UHW500', 'Sealing', '실링', '측정 전에 밀봉합니다.'),
    ];
    expect(rankPickItems(items, '활성 측정').map((i) => i.value)).toEqual(['UHW100', 'UHW380']);
  });
});

describe('withSelectedFirst', () => {
  const first = (query: string, selected?: string) => withSelectedFirst([...ITEMS], query, selected).map((i) => i.value);

  it('puts the current value at the top of the unsearched list', () => {
    expect(first('', 'UHW180')).toEqual(['UHW180', 'UHW060', 'UHW130', 'UHW190']);
  });

  it('leaves the order alone with nothing selected, or when it is first already', () => {
    expect(first('')).toEqual(['UHW060', 'UHW130', 'UHW180', 'UHW190']);
    expect(first('', 'UHW060')).toEqual(['UHW060', 'UHW130', 'UHW180', 'UHW190']);
    expect(first('', 'UHW999')).toEqual(['UHW060', 'UHW130', 'UHW180', 'UHW190']);
  });

  it('leaves a searched list to its ranking', () => {
    const ranked = withSelectedFirst(rankPickItems(ITEMS, '배양'), '배양', 'UHW060');
    expect(ranked.map((i) => i.value)).toEqual(['UHW180', 'UHW190', 'UHW060', 'UHW130']);
  });
});

describe('rankPickItems: catalog ranking (UI redesign Task 11)', () => {
  // The real bundled catalog, built the way the pickers build it (Korean UI)
  const wfItems = (workflows as { workflows: { id: string; name: string; description: string; category: string }[] }).workflows.map(
    (wf): PickItem<string> => ({ label: `${wf.id}: ${wf.name}`, ...catalogKoFields(wf.id, wf.category, wf.description, 'ko'), value: wf.id }),
  );
  const hwItems = (hw as { unitOperations: { id: string; name: string; description: string; equipment?: string }[] }).unitOperations.map(
    (op): PickItem<string> => {
      const fields = catalogKoFields(op.id, 'HW', op.description, 'ko');
      const searchWords = [...(fields.searchWords ?? []), ...(op.equipment ? [op.equipment] : [])];
      return { label: `${op.id}: ${op.name}`, ...fields, ...{ searchWords }, value: op.id } as PickItem<string>;
    },
  );
  const ids = (items: PickItem<string>[], q: string) => rankPickItems(items, q).map((i) => i.value);

  it('an exact code comes first', () => {
    expect(ids(wfItems, 'wb030')[0]).toBe('WB030');
    expect(ids(hwItems, 'UHW380')[0]).toBe('UHW380');
  });

  it('조립 ranks WB030 (ko name "DNA 조립") above WB010 (DNA 올리고머 조립)', () => {
    const found = ids(wfItems, '조립');
    expect(found.indexOf('WB030')).toBeGreaterThanOrEqual(0);
    expect(found.indexOf('WB030')).toBeLessThan(found.indexOf('WB010'));
  });

  it('an exact English name beats a name that only starts with it', () => {
    expect(ids(wfItems, 'dna assembly')[0]).toBe('WB030');
  });

  it('"plate reader" and "reader" find UHW380 Microplate Reading (token-AND across name, description and equipment)', () => {
    expect(ids(hwItems, 'plate reader')).toContain('UHW380');
    expect(ids(hwItems, 'reader')).toContain('UHW380');
  });

  it('"PCR" puts UHW110 Real-time PCR (a word of the name) above UHW100 Thermocycling (a search word)', () => {
    const found = ids(hwItems, 'PCR');
    expect(found[0]).toBe('UHW110');
    expect(found).toContain('UHW100');
    expect(found.indexOf('UHW110')).toBeLessThan(found.indexOf('UHW100'));
  });

  it('every token must match somewhere', () => {
    expect(ids(hwItems, 'plate zzzz')).toEqual([]);
  });

  it('the Korean name is searchable in the English UI too, but only the Korean UI shows it', () => {
    const enItems = (workflows as { workflows: { id: string; name: string; description: string; category: string }[] }).workflows.map(
      (wf): PickItem<string> => ({ label: `${wf.id}: ${wf.name}`, ...catalogKoFields(wf.id, wf.category, wf.description, 'en'), value: wf.id }),
    );
    const found = ids(enItems, '조립');
    expect(found.indexOf('WB030')).toBeGreaterThanOrEqual(0);
    expect(found.indexOf('WB030')).toBeLessThan(found.indexOf('WB010'));
    const wb030 = enItems.find((i) => i.value === 'WB030')!;
    expect(wb030.description).toBe('Build');
    expect(wfItems.find((i) => i.value === 'WB030')!.description).toBe('DNA 조립 · Build');
  });
});
