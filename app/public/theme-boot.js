// 첫 그림 전에 저장된 수동 테마를 건다. index.html 의 <head> 에서 막는 고전 스크립트로 불린다.
// CSP(script-src 'self')는 인라인 스크립트만 막고, 같은 출처의 이 파일은 허용한다.
// 이것이 없으면 라이트 OS 에서 다크를 고른 사람이 React 가 뜰 때까지 라이트 한 프레임을 본다.
// 뜬 뒤의 기준은 src/theme/useTheme.ts 이고, 이 파일은 그 첫 프레임만 맡는다: 키와 값의 규칙이 같아야 한다
// (src/theme/__tests__/themeBoot.test.ts 가 같은 키를 쓰는지 본다).
// 저장소가 없거나 막혀 던지거나 값을 모르면 속성을 지운다: 시스템 설정을 따른다.
(function () {
  try {
    var theme = localStorage.getItem('labnoteo.theme');
    // System(또는 모르는 값)이면 속성을 지운다: tokens.css 의 시스템 다크 블록은 :root:not([data-theme]) 에만 걸린다
    if (theme === 'dark' || theme === 'light') document.documentElement.setAttribute('data-theme', theme);
    else document.documentElement.removeAttribute('data-theme');
  } catch (e) {
    // 저장소를 쓸 수 없다: useTheme 도 같은 경우 system 으로 시작한다
    document.documentElement.removeAttribute('data-theme');
  }
})();
