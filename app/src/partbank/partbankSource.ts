import type { PartbankFeature } from '../labnote/port/partbankFeature';
import { pickPartbankReference, strainTypeOf } from '../labnote/port/partbankRegister';
import { PARTBANK_ORDER, partbankRowLabel, partbankSearchType } from '../labnote/port/partbankSuggest';
import type { SampleActionRow, SampleCandidateSource } from '../samples/sources';

/**
 * `@` 완성의 "Search partbank" 줄을 내는 출처(plan Task 19). `rows` 는 키를 누를 때마다 불리므로 네트워크를 쓰지 않는다:
 * 연결이 설정되었는지(캐시된 키 상태)와 종류만 보고 줄을 하나 내거나 내지 않는다. 검색은 줄을 고른 뒤 `run` 이 여는
 * 대화상자(debounce)가 한다. `feature` 는 지금 열린 보관함의 기능을 돌려준다(없으면 partbank 가 꺼진 것). 등록은 Task 26.
 */
export function partbankSource(feature: () => PartbankFeature | undefined): SampleCandidateSource {
  return {
    id: 'partbank',
    async rows(q, env) {
      const f = feature();
      if (!f) return [];
      const strainType = strainTypeOf(env);
      const type = partbankSearchType(f.configured, q.trigger, strainType);
      if (type === undefined) return [];
      const row: SampleActionRow = {
        kind: 'action',
        source: 'partbank',
        type,
        ...partbankRowLabel(env.t, type, strainType),
        order: PARTBANK_ORDER,
        run: (query) => pickPartbankReference(env, f, { type, initialQuery: query.typed ?? '' }),
      };
      return [row];
    },
  };
}
