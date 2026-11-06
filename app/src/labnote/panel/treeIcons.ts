/**
 * 코어 트리 모델(buildExperimentTree, buildWorkflowTree)의 아이콘 이름 -> CSS 클래스. 클래스는 app.css 에서
 * CSS 만으로 글리프를 그린다(토큰 색, 그림 파일 없음). 모르는 이름은 'ti-none'(빈 자리)이다.
 */
export const TREE_ICON_CLASS: Record<string, string> = {
  beaker: 'ti-beaker',
  folder: 'ti-folder',
  file: 'ti-file',
  warning: 'ti-warning',
  'comment-discussion': 'ti-discuss',
  'symbol-class': 'ti-class',
  'symbol-method': 'ti-method',
  'symbol-function': 'ti-function',
};

export function iconClass(icon: string | undefined): string {
  return (icon !== undefined && Object.hasOwn(TREE_ICON_CLASS, icon) && TREE_ICON_CLASS[icon]) || 'ti-none';
}
