import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// CodeMirror 는 그림자 루트 안에서 adoptedStyleSheets 로 스타일을 넣으므로 style-src 에 'unsafe-inline' 이 필요 없다.
// 이 테스트는 누가 편하자고 CSP 를 다시 열거나 지우는 것을 막는다. (개발 서버용 devCsp 는 따로 두며 여기서 보지 않는다.)
const conf = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf-8'));

function directives(csp: string): Record<string, string[]> {
  return Object.fromEntries(
    csp
      .split(';')
      .map((d) => d.trim().split(/\s+/))
      .filter((d) => d[0])
      .map(([name, ...values]) => [name, values]),
  );
}

describe('콘텐츠 보안 정책', () => {
  const csp: unknown = conf.app.security.csp;

  it('정책이 있다 (null 이 아니다)', () => {
    expect(typeof csp).toBe('string');
  });

  it('스크립트와 스타일은 앱 자신의 파일만 허용한다', () => {
    const d = directives(csp as string);
    expect(d['script-src']).toEqual(["'self'"]);
    expect(d['style-src']).toEqual(["'self'"]);
    expect(d['default-src']).toEqual(["'self'"]);
    expect(d['object-src']).toEqual(["'none'"]);
  });

  it('Tauri IPC 가 쓰는 연결은 열려 있다', () => {
    const d = directives(csp as string);
    expect(d['connect-src']).toEqual(expect.arrayContaining(['ipc:', 'http://ipc.localhost']));
  });

  // 보관함 이미지는 확인된 바이트(vault_read_image)를 blob: URL 로 보인다. 바깥 주소(http:)는 열지 않는다.
  it('img-src allows self, data and blob only', () => expect(directives(csp as string)['img-src']).toEqual(["'self'", 'data:', 'blob:']));

  it('devCsp img-src allows the same image sources', () =>
    expect(directives(conf.app.security.devCsp as string)['img-src']).toEqual(["'self'", 'data:', 'blob:']));
});

// style-src 'self' 는 style="..." 속성도 막는다. React 의 style={{...}} 는 그 속성으로 나온다.
function tsx(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === '__tests__' ? [] : tsx(p);
    return name.endsWith('.tsx') ? [p] : [];
  });
}

describe('인라인 스타일', () => {
  it('화면 컴포넌트는 style 속성을 쓰지 않는다 (모양은 styles/*.css)', () => {
    const offenders = tsx('src').filter((f) => /style=\{/.test(readFileSync(f, 'utf-8')));
    expect(offenders).toEqual([]);
  });

});

// script-src 'self' 는 같은 출처의 파일은 허용하고 인라인 스크립트는 막는다. 개발 서버의 CSP 는 느슨해서 인라인을 써도 개발 중에는 보이지 않는다.
describe('index.html', () => {
  const page = readFileSync('index.html', 'utf-8');
  const scripts = [...page.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)].map((m) => ({ attrs: m[1], body: m[2], at: m.index! }));
  const headEnd = page.search(/<\/head\s*>/i);
  // 따옴표가 든 정규식은 String.raw 로 쓴다: escapes.test.ts 는 정규식 리터럴 안의 따옴표를 문자열의 시작으로 읽는다.
  const SRC = new RegExp(String.raw`\bsrc="([^"]*)"`);
  const srcOf = (attrs: string) => SRC.exec(attrs)?.[1];

  it('인라인 스크립트가 없다: 모든 <script> 는 src 로 같은 출처의 파일을 부르고 본문이 비어 있다', () => {
    expect(scripts.length).toBeGreaterThanOrEqual(2); // 부트 스크립트와 앱 진입점을 실제로 읽었다
    for (const s of scripts) {
      expect(srcOf(s.attrs), s.attrs).toMatch(/^\/[^/]/); // 루트 기준 경로: http(s):, //host 가 아니다
      expect(s.body.trim(), s.attrs).toBe('');
    }
    // 인라인 이벤트 처리기와 javascript: URL 도 인라인 스크립트다
    expect(page).not.toMatch(/\son[a-z]+\s*=/i);
    expect(page).not.toMatch(/javascript:/i);
  });

  it('테마 부트 스크립트는 <head> 에서 앱보다 먼저, 막는 고전 스크립트로 돈다 (첫 그림 전에 data-theme 이 걸린다)', () => {
    const boot = scripts.find((s) => srcOf(s.attrs) === '/theme-boot.js');
    const app = scripts.find((s) => srcOf(s.attrs) === '/src/main.tsx');
    expect(boot).toBeDefined();
    expect(app).toBeDefined();
    expect(headEnd).toBeGreaterThanOrEqual(0); // </head> 를 찾지 못하면(-1) 아래 비교가 헛돈다
    expect(boot!.at).toBeLessThan(headEnd); // <head> 안
    expect(boot!.at).toBeLessThan(app!.at);
    expect(boot!.attrs).not.toMatch(/\b(type|async|defer)\b/); // 모듈·async·defer 는 첫 그림 뒤로 밀릴 수 있다
    // Vite 는 public/ 을 dist 맨 위로 그대로 복사한다: 앱과 같은 출처의 /theme-boot.js 가 된다
    expect(statSync('public/theme-boot.js').isFile()).toBe(true);
  });

  it('html 의 처음 lang 은 저장소도 한국어 브라우저도 없을 때의 기본값 en 이다 (부트 스크립트가 못 돌아도 맞는 쪽)', () => {
    expect(page).toMatch(/<html lang="en">/);
  });

  it('언어 부트 스크립트도 <head> 에서 앱보다 먼저, 막는 고전 스크립트로 돈다 (첫 그림 전에 html lang 이 맞다)', () => {
    const boot = scripts.find((s) => srcOf(s.attrs) === '/lang-boot.js');
    const app = scripts.find((s) => srcOf(s.attrs) === '/src/main.tsx');
    expect(boot).toBeDefined();
    expect(app).toBeDefined();
    expect(headEnd).toBeGreaterThanOrEqual(0);
    expect(boot!.at).toBeLessThan(headEnd);
    expect(boot!.at).toBeLessThan(app!.at);
    expect(boot!.attrs).not.toMatch(/\b(type|async|defer)\b/);
    expect(statSync('public/lang-boot.js').isFile()).toBe(true);
  });
});

// 창은 숨긴 채 뜬다: useTheme 이 첫 테마를 건 뒤(또는 1.5 초 뒤) show 하고, lib.rs 가 3 초 뒤에도 숨어 있으면 보인다.
describe('창 시작', () => {
  it('주 창은 visible:false 로 뜬다 (제목 표시줄이 OS 테마로 한 번 비치지 않게)', () => {
    expect(conf.app.windows).toHaveLength(1);
    expect(conf.app.windows[0].visible).toBe(false);
  });
});

// 권한은 쓰는 것만 하나씩 연다. 목록을 통째로 고정해, 누가 편하자고 권한을 넓히면 여기서 보인다.
describe('창 권한', () => {
  const cap = JSON.parse(readFileSync('src-tauri/capabilities/default.json', 'utf-8'));

  it('기본 권한 묶음은 정확히 이 목록이다 (set-theme 은 제목 표시줄을 고른 테마에 맞추려고, show 는 숨겨 띄운 창을 첫 테마 뒤에 보이려고 연다)', () => {
    expect(cap.windows).toEqual(['main']);
    expect(cap.permissions).toEqual([
      'core:default',
      'core:window:allow-destroy',
      'core:window:allow-set-theme',
      'core:window:allow-show',
      'dialog:allow-open',
      'dialog:allow-save',
      'updater:default',
      'process:allow-restart',
      // 바깥 링크 열기(SP4 Task 11): opener 는 이 네 스킴으로만 범위를 좁힌다. capabilities.test.ts 도 지킨다.
      { identifier: 'opener:allow-open-url', allow: [{ url: 'http://*' }, { url: 'https://*' }, { url: 'mailto:*' }, { url: 'partbank:*' }] },
    ]);
  });

  // gen/schemas 는 cargo 빌드가 만드는 gitignore 된 산출물이라 CI 의 npm test(cargo 보다 먼저 돈다)와 새 클론에는 없다.
  // 대신 npm ci 가 package-lock 그대로 까는 @tauri-apps/api 의 창 API 문서를 읽는다: 메서드마다 "Requires the `…` permission" 을 적어 둔다.
  // 플러그인·묶음 권한(dialog:, updater:, process:, core:default)은 거기에 없으므로 위의 고정 목록만이 지킨다.
  it('여는 창 권한(core:window:allow-*)은 @tauri-apps/api 가 그 메서드에 요구한다고 적은 이름이다', () => {
    const api = readFileSync('node_modules/@tauri-apps/api/window.d.ts', 'utf-8');
    const REQUIRES = new RegExp(String.raw`Requires the .(core:window:allow-[\w-]+). permission`, 'g');
    const required = new Set([...api.matchAll(REQUIRES)].map((m) => m[1]));
    expect(required.size).toBeGreaterThan(10); // 문서를 실제로 읽었다
    const windowPerms = (cap.permissions as unknown[]).filter((p): p is string => typeof p === 'string' && p.startsWith('core:window:'));
    expect(windowPerms.length).toBeGreaterThanOrEqual(2); // 위 목록이 고정한 destroy·set-theme
    for (const p of windowPerms) expect(required.has(p), p).toBe(true);
  });
});
