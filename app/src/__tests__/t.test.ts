import { t } from '../i18n/t';

it('위치 인자 {0} {1} 을 치환한다', () => {
  expect(t('test.greeting', '보관함', 3)).toBe('보관함 에 노트 3 개');
});

it('없는 키는 키 자체를 돌려준다', () => {
  expect(t('no.such.key')).toBe('no.such.key');
});
