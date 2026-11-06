import { setLang } from '../i18n/lang';

// 기존 테스트는 한국어 글자로 요소를 찾는다. 기계의 브라우저 언어(navigator.language)나 저장소와 상관없이
// 모든 테스트를 한국어로 시작한다. 한 테스트가 영어로 바꿔도 다음 테스트로 새지 않는다.
// (모듈은 테스트 파일마다 새로 읽히므로, 파일 사이에도 새지 않는다.)
setLang('ko');
beforeEach(() => setLang('ko'));
