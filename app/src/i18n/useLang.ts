import { useSyncExternalStore } from 'react';
import { getLang, subscribeLang, type Lang } from './lang';

/**
 * 지금 화면 언어. 언어가 바뀌면 이 훅을 부른 컴포넌트가 (다시 마운트되지 않고) 다시 그려진다.
 * App 이 부르므로 그 아래 전부가 따라 그려진다. React.memo 로 감싼 컴포넌트는 부모를 따라 그려지지 않으니
 * 그 안에서 t 를 쓰면 이 훅을 직접 불러야 한다.
 */
export function useLang(): Lang {
  return useSyncExternalStore(subscribeLang, getLang, getLang);
}
