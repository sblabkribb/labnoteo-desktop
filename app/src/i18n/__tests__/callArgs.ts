/**
 * `callee` 가 찾은 부름마다 첫 인자(최상위 쉼표나 닫는 괄호까지)의 글자. 줄을 넘는 인자와
 * `t(gone ? 'a' : 'b')` 같은 삼항, 괄호 안의 쉼표도 견딘다. `callee` 는 g 플래그가 있는 정규식이고,
 * 맞은 글자가 여는 괄호로 끝나야 한다. 테스트가 쓰는 도우미라 테스트 폴더에 두지만 *.test.* 가 아니라 따로 돌지 않는다.
 */
export function firstArgsOf(code: string, callee: RegExp): string[] {
  const out: string[] = [];
  for (const m of code.matchAll(callee)) {
    let depth = 0;
    let quote = '';
    let i = m.index! + m[0].length;
    const start = i;
    for (; i < code.length; i++) {
      const c = code[i];
      if (quote) {
        if (c === '\\') i++;
        else if (c === quote) quote = '';
        continue;
      }
      if (c === "'" || c === '"' || c === '`') quote = c;
      else if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') {
        if (depth === 0) break;
        depth--;
      } else if (c === ',' && depth === 0) break;
    }
    out.push(code.slice(start, i));
  }
  return out;
}
