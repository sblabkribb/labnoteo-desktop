import type { SelectHTMLAttributes } from 'react';
import { Icon } from './Icon';

/**
 * 대화상자 양식 안의 네이티브 `<select>`(명세 §3.8): 브라우저 기본 화살표를 지우고(appearance: none) 앱의 chevron 아이콘을
 * 겹쳐 그린다. 고르기 동작과 접근성은 네이티브 그대로다(라벨, 키보드, 화면 읽기). 크롬의 고르기는 SelectMenu 를 쓴다.
 */
export function SelectField(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <span className="select-field">
      <select {...props} />
      <Icon name="chevron-down" size={14} />
    </span>
  );
}
