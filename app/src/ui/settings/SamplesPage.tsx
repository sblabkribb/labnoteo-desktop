import { useRef } from 'react';
import { SampleSettingsForm, sampleSettingsMayAsk, type SampleSettingsValue } from '../../samples/SampleSettingsDialog';

export interface SamplesDeps {
  /** 지금 보관함 설정의 샘플 세 값. */
  value(): SampleSettingsValue;
  /** 바뀐 값을 저장하고 샘플 저장소를 다시 묶는다. 옛 폴더의 샘플 옮기기·지운 종류 되돌리기를 물을 수 있다. */
  apply(before: SampleSettingsValue, after: SampleSettingsValue): Promise<void>;
}

/**
 * 설정 → 샘플: 예전 샘플 설정 대화상자의 내용(SampleSettingsForm). 다른 쪽처럼 바꾸면 바로 적용한다:
 * - 묻는 것이 없을 변경(추적 스위치, 종류 더하기)은 이 창 안에서 바로 적용한다;
 * - Global 폴더를 바꾸거나 종류를 지웠으면 설정 창을 먼저 닫고 적용한다(묻는 대화상자가 이 창 뒤에 줄 서지 않게).
 */
export function SamplesPage(props: { deps: SamplesDeps; leave: (after: () => Promise<void>) => void }) {
  const before = useRef<SampleSettingsValue>(props.deps.value());
  const onSave = (after: SampleSettingsValue) => {
    const from = before.current;
    if (sampleSettingsMayAsk(from, after)) {
      props.leave(() => props.deps.apply(from, after));
      return;
    }
    before.current = after;
    void props.deps.apply(from, after);
  };
  return <SampleSettingsForm value={before.current} onSave={onSave} />;
}
