import { afterEach, describe, expect, it } from 'vitest';
import { extractSampleInfoFromText } from '@labnoteo/core/lib/sampleStorage';
import { maskSampleListTables } from '@labnoteo/core/lib/sampleUtils';
import { getLang, setLang } from '../../i18n/lang';
import { coreT } from '../../labnote/i18n';
import { sampleListHeaders } from '../../labnote/port/sampleListTable';
import { sampleTypesFor } from '../types';
import { koListHeader } from './fixtures';

/**
 * 계획의 `extractSampleReferences` 는 core 에 그런 이름이 없다. `saveSamplesFromDocument`(sampleStorage.ts:1522)
 * 가 목록 표 행을 가리는 실제 조합 `extractSampleInfoFromText(maskSampleListTables(text, headers), types)` 를 쓴다.
 */
function extractSampleReferences(text: string, types: string[], headers: string[][]) {
  return extractSampleInfoFromText(maskSampleListTables(text, headers), types);
}

const before = getLang();
afterEach(() => setLang(before));

describe('sample list-table headers', () => {
  it('headers recognised in ko and en', async () => {
    expect(koListHeader().split('\n')[0]).toBe('| ID | 별칭 | 설명 | 보관 위치 | 범위 | 폐기 |');
    const body = `${koListHeader()}\n| DNA-77 | x | | | 로컬 | |\n\n| ID | Alias | Description | Location | Scope | Discarded |\n|---|---|---|---|---|---|\n| DNA-78 | y | | | Local | |\n`;
    const types = sampleTypesFor({ customSampleTypes: [] });
    // 가리지 않으면 두 ID 가 모두 나온다: 아래 not.toContain 이 헛돌지 않는다는 확인.
    const unmasked = extractSampleInfoFromText(body, types).map((r) => r.id);
    expect(unmasked).toEqual(expect.arrayContaining(['DNA-77', 'DNA-78']));
    const refs = extractSampleReferences(body, types, sampleListHeaders({ t: coreT }));
    expect(refs.map((r) => r.id)).not.toContain('DNA-77');
    expect(refs.map((r) => r.id)).not.toContain('DNA-78');
  });

  it('koListHeader restores the previous language', () => {
    setLang('en');
    koListHeader();
    expect(getLang()).toBe('en');
  });
});
