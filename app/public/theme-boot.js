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

// 화면 배치의 거울(src/ui/layoutStore.ts 의 LAYOUT_KEY)도 첫 그림 전에 건다. 캐시일 뿐이다:
// 앱에서는 Rust ui.json 이 layoutStore.load() 에서 이기고, 창은 그 뒤에 보인다. 이 몫은 브라우저 하네스의 첫 프레임이다.
// 범위와 기본값은 layoutStore.ts·ui_prefs.rs 와 같다. 거울이 없거나 깨졌으면 아무것도 걸지 않는다(CSS 기본값).
// CSP(style-src 'self') 때문에 style 속성 문자열은 쓰지 않고 CSSOM(setProperty)만 쓴다.
(function () {
  try {
    var raw = localStorage.getItem('labnoteo.ui.layout');
    if (!raw) return;
    var p = JSON.parse(raw);
    if (!p || typeof p !== 'object') return;
    var width = function (v, min, max, d) {
      return typeof v === 'number' && isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : d;
    };
    var root = document.documentElement;
    root.style.setProperty('--side-w', width(p.leftWidth, 200, 480, 272) + 'px');
    root.style.setProperty('--right-w', width(p.rightWidth, 220, 480, 280) + 'px');
    root.setAttribute('data-left-hidden', String(p.leftHidden === true));
    root.setAttribute('data-right-open', String(p.rightOpen === true));
    root.setAttribute('data-density', p.density === 'compact' ? 'compact' : 'comfortable');
  } catch (e) {
    // 저장소를 쓸 수 없거나 거울이 깨졌다: CSS 기본값으로 그린다
  }
})();
