import { KO_COMMAND_NAMES } from '@labnoteo/core/lib/labnoteStructure';
import { setLang } from '../../i18n/lang';
import { coreLocale, coreT, overrideOr, paletteName } from '../i18n';

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

  // README 템플릿의 Ctrl+P 안내가 참이려면 팔레트 이름(coreT)이 코어 상수와 같아야 한다. Task 9 가 셋 모두 등록한다.
  it('KO_COMMAND_NAMES match coreT in Korean', () => {
    expect(coreT('Create workflow')).toBe(KO_COMMAND_NAMES.createWorkflow);
    expect(coreT('Insert unit operation')).toBe(KO_COMMAND_NAMES.insertUnitOperation);
    expect(coreT('Sync workflow checklist with folder')).toBe(KO_COMMAND_NAMES.syncWorkflowChecklist);
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
