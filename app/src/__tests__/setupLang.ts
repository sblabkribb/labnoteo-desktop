import { setLang } from '../i18n/lang';

// 기존 테스트는 한국어 글자로 요소를 찾는다. 기계의 브라우저 언어(navigator.language)나 저장소와 상관없이
// 모든 테스트를 한국어로 시작한다. 한 테스트가 영어로 바꿔도 다음 테스트로 새지 않는다.
// (모듈은 테스트 파일마다 새로 읽히므로, 파일 사이에도 새지 않는다.)
setLang('ko');
beforeEach(() => setLang('ko'));

// 화면 배치(ui/layoutStore)는 모듈 하나가 기억한다: 같은 파일의 앞 테스트가 바꾼 독의 탭·숨김이 다음 테스트로 새지 않게 기본값으로 돌린다.
// 동적 import 라 테스트 파일의 vi.mock 이 걸린 같은 모듈을 받는다(이 파일이 먼저 읽어 진짜 IPC 를 붙잡지 않는다).
beforeEach(async () => {
  const { layoutStore } = await import('../ui/layoutStore');
  layoutStore.resetForTest();
});
