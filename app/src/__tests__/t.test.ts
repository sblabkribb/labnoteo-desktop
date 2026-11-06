import { format, t } from '../i18n/t';

it('위치 인자 {0} {1} 을 치환한다', () => {
  expect(format('{0} 에 노트 {1} 개', ['보관함', 3])).toBe('보관함 에 노트 3 개');
  expect(format('{0}-{0}', ['x'])).toBe('x-x');
  expect(format('{0} {1}', ['모자람'])).toBe('모자람 {1}'); // 모자란 인자는 자리 표시를 남긴다
  expect(t('vault.open', '연구실')).toBe('보관함: 연구실');
});

it('없는 키는 키 자체를 돌려준다', () => {
  expect(t('no.such.key')).toBe('no.such.key');
});
