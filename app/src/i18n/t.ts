// UI 문자열 이음새. 모든 화면 문자열은 이 함수를 거친다 (리터럴 직접 기재 금지).
const ko: Record<string, string> = {
  'app.title': 'labnoteO',
  'app.ready': '보관함 셸이 준비되었습니다',
  'test.greeting': '{0} 에 노트 {1} 개',
};

export function t(key: string, ...args: Array<string | number | boolean>): string {
  const template = ko[key];
  if (template === undefined) return key;
  return template.replace(/\{(\d+)\}/g, (m, i: string) => {
    const v = args[Number(i)];
    return v === undefined ? m : String(v);
  });
}
