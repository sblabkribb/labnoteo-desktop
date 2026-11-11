import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import obsidianKo from '../../../vendor/labnoteo/src/l10n.ko';
import workflows from '../../../vendor/labnoteo/packages/labnoteo-core/src/catalog/workflows_en.json';
import hw from '../../../vendor/labnoteo/packages/labnoteo-core/src/catalog/unitoperations_hw_en.json';
import { coreT, koTerms, vendorKo } from '../../labnote/i18n';
import { catalogKoFields } from '../../labnote/port/aliasHints';
import { KOREAN_TERMS_INSTRUCTION, replyLanguageInstruction } from '../../labnote/port/aiCommon';
import { setLang } from '../lang';
import { catalogs } from '../t';

/**
 * 용어 규칙(2026-11-11): 한국어 화면과 AI 의 한국어 답에서 'Workflow' 와 'Unit Operation' 은 영어로 쓴다.
 * 워크플로 / 단위 공정 / 유닛 오퍼레이션(띄어 쓰든 붙여 쓰든)은 보이는 글에 다시 들어오면 안 된다.
 */
const OLD_TERMS = /워크플로|단위\s*공정|유닛\s*오퍼레이션/;

const root = join(__dirname, '..', '..', '..');

describe('용어 규칙: Workflow / Unit Operation 은 한국어 화면에서도 영어', () => {
  afterEach(() => setLang('ko'));

  it('앱 한국어 목록(t.ts)의 어느 문장에도 워크플로 / 단위 공정 / 유닛 오퍼레이션이 없다', () => {
    const bad = Object.entries(catalogs.ko)
      .filter(([, v]) => OLD_TERMS.test(v))
      .map(([k, v]) => `${k}: ${v}`);
    expect(bad).toEqual([]);
    expect(catalogs.ko['chip.unitOp']).toBe('Unit Operation 만들기'); // 검사가 실제 목록을 읽었다
    expect(catalogs.ko['chip.workflow']).toBe('Workflow 만들기');
  });

  it('플러그인 문장(coreT)도 한국어에서 옛 낱말 없이 보인다: 템플릿만 바꾸고 조사는 그대로 맞는다', () => {
    setLang('ko');
    const keys = Object.keys(obsidianKo);
    const bad = keys.map((k) => coreT(k)).filter((v) => OLD_TERMS.test(v));
    expect(bad).toEqual([]);
    // 원문에 옛 낱말이 실제로 있었다(검사가 헛돌지 않는다)
    expect(keys.filter((k) => OLD_TERMS.test(obsidianKo[k])).length).toBeGreaterThan(50);
    expect(coreT('Create workflow')).toBe('Workflow 생성');
    expect(coreT('Auto-sync unit operation TOC')).toBe('Unit Operation TOC 자동 정렬');
    expect(coreT('This inserts unit operation {0} into {1}.', 'X', 'Y')).toBe('Unit Operation X을(를) Y에 넣습니다.');
    expect(coreT("Which unit operation's Method should the draft go in?")).toBe('초안을 어느 Unit Operation의 Method에 넣을까요?');
  });

  it('{0} 에 들어가는 사용자 글(노트 제목 등)은 바꾸지 않는다', () => {
    setLang('ko');
    expect(coreT('Workflow created: {0}', '단백질 발현 워크플로')).toBe('Workflow가 생성되었습니다: 단백질 발현 워크플로');
  });

  it('영어 화면은 그대로다', () => {
    setLang('en');
    expect(coreT('Create workflow')).toBe('Create workflow');
  });

  it('카탈로그 고르기의 한국어 이름·설명도 용어 규칙을 따르고, 플러그인 한국어 이름은 찾기 낱말로 남는다', () => {
    const items = [
      ...(workflows as { workflows: { id: string; category: string; description: string }[] }).workflows,
      ...(hw as { unitOperations: { id: string; description: string }[] }).unitOperations.map((o) => ({ ...o, category: 'HW' })),
      { id: 'WG010', category: 'General', description: 'Generic empty workflow' },
    ];
    const bad = items
      .map((i) => catalogKoFields(i.id, i.category, i.description, 'ko'))
      .flatMap((f) => [f.description, f.detail])
      .filter((v) => OLD_TERMS.test(v));
    expect(bad).toEqual([]);
    const retired = catalogKoFields('WG010', 'General', 'Generic empty workflow', 'ko');
    expect(retired.description).toBe('빈 Workflow · General');
    expect(retired.keywords).toEqual(['빈 워크플로', '빈 Workflow']);
    expect(catalogKoFields('WG010', 'General', 'Generic empty workflow', 'en').detail).toBe('Generic empty workflow');
  });

  it('koTerms 는 세 옛 낱말을 바꾸고, vendorKo 는 플러그인 원문을 준다', () => {
    expect(koTerms('워크플로를 단위 공정으로, 유닛오퍼레이션이')).toBe('Workflow를 Unit Operation으로, Unit Operation이');
    expect(vendorKo('Create workflow')).toBe('워크플로 생성');
    expect(vendorKo('no such key')).toBeUndefined();
  });

  it('AI 의 한국어 답 지시에 용어 규칙이 붙는다(다른 언어에는 붙지 않는다)', () => {
    expect(replyLanguageInstruction('ko')).toContain(KOREAN_TERMS_INSTRUCTION);
    expect(replyLanguageInstruction('en')).not.toContain(KOREAN_TERMS_INSTRUCTION);
    expect(KOREAN_TERMS_INSTRUCTION).toContain('"Workflow"');
    expect(KOREAN_TERMS_INSTRUCTION).toContain('"Unit Operation"');
  });

  it('MCP 서버(Rust)의 instructions 는 웹뷰와 같은 문장이다', () => {
    const rs = readFileSync(join(root, 'src-tauri', 'src', 'mcp', 'rpc.rs'), 'utf8');
    const m = rs.match(/pub const KOREAN_TERMS_INSTRUCTION: &str = "((?:\\.|[^"\\])*)";/);
    expect(m).not.toBeNull();
    expect(m![1].replace(/\\"/g, '"')).toBe(KOREAN_TERMS_INSTRUCTION);
  });

  it('SKILL.md 가 외부 에이전트에게 같은 규칙을 알려 준다', () => {
    const skill = readFileSync(join(root, 'src-tauri', 'resources', 'skills', 'labnoteo', 'SKILL.md'), 'utf8');
    expect(skill).toContain('## Terms in Korean');
    expect(skill).toMatch(/write \*\*Workflow\*\* and \*\*Unit Operation\*\* in English/);
  });
});
