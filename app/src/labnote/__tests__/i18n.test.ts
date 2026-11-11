import { KO_COMMAND_NAMES } from '@labnoteo/core/lib/labnoteStructure';
import { setLang } from '../../i18n/lang';
import { coreLocale, coreT, koTerms, overrideOr, paletteName, vendorKo } from '../i18n';

describe('코어 번역 다리', () => {
  it('coreT follows a language switch without re-creation', () => {
    setLang('en');
    expect(coreT('Create experiment')).toBe('Create experiment');
    expect(coreLocale()).toBe('en');
    setLang('ko');
    expect(coreT('Create experiment')).toBe('실험 생성');
    expect(coreLocale()).toBe('ko');
  });

  it('모르는 키는 영어 원문으로, 자리 표시는 채워서 돌려준다', () => {
    expect(coreT('No such key {0}', 3)).toBe('No such key 3');
  });

  // README 템플릿의 Ctrl+P 안내(파일 내용, 코어 상수)는 플러그인 한국어 이름을 적는다. 앱 팔레트는 용어 규칙으로
  // 'Workflow 생성' 이라 보이지만 플러그인 이름(vendorKo)도 찾기 낱말로 받으므로(CommandPalette.test) 안내는 참이다.
  it('KO_COMMAND_NAMES are the plugin names; coreT shows them with the term rule', () => {
    const cases: Array<[string, string]> = [
      ['Create workflow', KO_COMMAND_NAMES.createWorkflow],
      ['Insert unit operation', KO_COMMAND_NAMES.insertUnitOperation],
      ['Sync workflow checklist with folder', KO_COMMAND_NAMES.syncWorkflowChecklist],
    ];
    for (const [key, ko] of cases) {
      expect(vendorKo(key)).toBe(ko);
      expect(coreT(key)).toBe(koTerms(ko));
    }
    expect(coreT('Create workflow')).toBe('Workflow 생성');
    expect(coreT('Insert unit operation')).toBe('Unit Operation 삽입');
    expect(coreT('Sync workflow checklist with folder')).toBe('폴더와 Workflow 체크리스트 맞추기');
  });

  it('paletteName 은 지금 언어의 이름 하나만 보인다(영어를 괄호로 붙이지 않는다), 시료는 샘플로', () => {
    expect(paletteName('Create experiment')).toBe('실험 생성');
    expect(paletteName('Insert sample list of this experiment')).not.toContain('시료');
    setLang('en');
    expect(paletteName('Create experiment')).toBe('Create experiment');
  });

  it('overrideOr 은 앱 번역을 돌려주고 언어를 따른다', () => {
    expect(overrideOr('insertDate.noNote')).toBe('노트를 열고 날짜를 넣을 곳에 커서를 둔 다음 다시 실행하세요.');
    setLang('en');
    expect(overrideOr('issueMarker.noNote')).toBe('Open a note and put the cursor on the line to discuss, then run this again.');
    expect(overrideOr('insertDate.metaDateFilled')).toBe('This Start_date/End_date already has a value. Select the date and type over it.');
  });
});
