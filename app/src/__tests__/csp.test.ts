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
  it('화면 컴포넌트는 style 속성을 쓰지 않는다 (모양은 app.css)', () => {
    const offenders = tsx('src').filter((f) => /style=\{/.test(readFileSync(f, 'utf-8')));
    expect(offenders).toEqual([]);
  });

  it('트리 깊이마다 app.css 에 들여쓰기 규칙이 있다', () => {
    const css = readFileSync('src/app.css', 'utf-8');
    for (let d = 1; d <= 24; d++) expect(css).toContain(`[data-depth="${d}"] { padding-left: calc(var(--indent) * ${d}); }`);
  });
});

// script-src 'self' 는 같은 출처의 파일은 허용하고 인라인 스크립트는 막는다. 개발 서버의 CSP 는 느슨해서 인라인을 써도 개발 중에는 보이지 않는다.
describe('index.html', () => {
  const page = readFileSync('index.html', 'utf-8');
  const scripts = [...page.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)].map((m) => ({ attrs: m[1], body: m[2], at: m.index! }));
  const head = page.slice(0, page.search(/<\/head\s*>/i));

  it('인라인 스크립트가 없다: 모든 <script> 는 src 로 같은 출처의 파일을 부르고 본문이 비어 있다', () => {
    expect(scripts.length).toBeGreaterThanOrEqual(2); // 부트 스크립트와 앱 진입점을 실제로 읽었다
    for (const s of scripts) {
      expect(s.attrs, s.attrs).toMatch(/\bsrc="\/[^"/][^"]*"/); // 루트 기준 경로: http(s):, //host 가 아니다
      expect(s.body.trim(), s.attrs).toBe('');
    }
    // 인라인 이벤트 처리기와 javascript: URL 도 인라인 스크립트다
    expect(page).not.toMatch(/\son[a-z]+\s*=/i);
    expect(page).not.toMatch(/javascript:/i);
  });

  it('테마 부트 스크립트는 <head> 에서 앱보다 먼저, 막는 고전 스크립트로 돈다 (첫 그림 전에 data-theme 이 걸린다)', () => {
    const boot = scripts.find((s) => /src="\/theme-boot\.js"/.test(s.attrs));
    const app = scripts.find((s) => /src="\/src\/main\.tsx"/.test(s.attrs));
    expect(boot).toBeDefined();
    expect(app).toBeDefined();
    expect(boot!.at).toBeLessThan(head.length); // <head> 안
    expect(boot!.at).toBeLessThan(app!.at);
    expect(boot!.attrs).not.toMatch(/\b(type|async|defer)\b/); // 모듈·async·defer 는 첫 그림 뒤로 밀릴 수 있다
    // Vite 는 public/ 을 dist 맨 위로 그대로 복사한다: 앱과 같은 출처의 /theme-boot.js 가 된다
    expect(statSync('public/theme-boot.js').isFile()).toBe(true);
  });
});
