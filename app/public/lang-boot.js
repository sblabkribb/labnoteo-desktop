// 첫 그림 전에 html lang 을 앱이 고를 언어로 건다. index.html 의 <head> 에서 막는 고전 스크립트로 불린다.
// CSP(script-src 'self')는 인라인 스크립트만 막고, 같은 출처의 이 파일은 허용한다.
// 뜬 뒤의 기준은 src/i18n/lang.ts 이고, 이 파일은 그 첫 프레임만 맡는다: 고르는 규칙이 같아야 한다
// (src/i18n/__tests__/langBoot.test.ts 가 같은 키와 같은 규칙을 쓰는지 본다).
// 저장된 ko/en 이 먼저, 없으면 navigator.language 가 ko 로 시작할 때만 ko, 그 밖에는 en.
// 저장소나 navigator 에 닿다가 던져도 조용히 넘어간다.
(function () {
  var lang = 'en';
  try {
    var browser = navigator.language;
    if (typeof browser === 'string' && browser.toLowerCase().indexOf('ko') === 0) lang = 'ko';
  } catch (e) {
    // navigator 가 없다: 영어
  }
  try {
    var stored = localStorage.getItem('labnoteo.lang');
    if (stored === 'ko' || stored === 'en') lang = stored;
  } catch (e) {
    // 저장소를 쓸 수 없다: lang.ts 도 같은 경우 브라우저 언어로 시작한다
  }
  document.documentElement.lang = lang;
})();
