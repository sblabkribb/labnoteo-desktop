import { setLang } from '../../i18n/lang';
import { statusKind, statusLabel, statusShape } from '../statusLabels';

afterEach(() => setLang('ko'));

describe('statusLabel / statusShape', () => {
  it('maps the stored values to localised labels in ko', () => {
    setLang('ko');
    expect(statusLabel('planned')).toBe('계획');
    expect(statusLabel('in-progress')).toBe('진행 중');
    expect(statusLabel('in_progress')).toBe('진행 중');
    expect(statusLabel('done')).toBe('완료');
    expect(statusLabel('completed')).toBe('완료');
  });

  it('maps the stored values to localised labels in en', () => {
    setLang('en');
    expect(statusLabel('planned')).toBe('Planned');
    expect(statusLabel('In-Progress')).toBe('In progress');
    expect(statusLabel('completed')).toBe('Done');
  });

  it("names the plugin's other statuses in the UI language and passes unknown values through as written", () => {
    setLang('ko');
    expect(statusLabel('needs-review')).toBe('검토 필요');
    expect(statusLabel('whatever we wrote')).toBe('whatever we wrote');
    setLang('en');
    expect(statusLabel('needs-review')).toBe('Needs review');
  });

  it('gives a shape per status', () => {
    expect(statusShape('planned')).toBe('dashed');
    expect(statusShape('in-progress')).toBe('half');
    expect(statusShape('done')).toBe('check');
    expect(statusShape('completed')).toBe('check');
    expect(statusShape('odd')).toBe('dashed');
    expect(statusKind('in_progress')).toBe('inProgress');
    expect(statusKind('odd')).toBeUndefined();
  });
});
