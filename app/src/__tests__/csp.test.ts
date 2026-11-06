import { readFileSync } from 'node:fs';

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
