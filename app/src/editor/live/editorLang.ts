import { Facet, type EditorState } from '@codemirror/state';
import { getLang, type Lang } from '../../i18n/lang';

/**
 * 편집기 상태 안의 화면 언어. 위젯과 장식은 글을 그릴 때 번역 함수로 읽지만, CodeMirror 는 eq() 가 참이면 그려 둔 DOM 을
 * 그대로 둔다. 그래서 글을 그리는 위젯은 이 값을 eq() 에 넣고, 장식을 만드는 필드·플러그인은 이 값이 바뀌면 다시 만든다.
 * Editor.tsx 가 언어를 바꿀 때 이름표 칸과 함께 이 값을 갈아 끼운다: 본문을 바꾸지 않으므로 저장 안 됨 표시, 되돌리기 기록,
 * 선택은 그대로다.
 *
 * 편집기 밖에서 만든 상태(테스트, 셀 편집기)에는 값이 없다: 그때는 그 상태를 만들 때의 언어다.
 */
export const editorLang = Facet.define<Lang, Lang>({
  combine: (values) => values[0] ?? getLang(),
});

/** 이 갱신에서 화면 언어가 바뀌었는가(장식을 다시 만들 때). */
export const langChanged = (u: { startState: EditorState; state: EditorState }): boolean =>
  u.startState.facet(editorLang) !== u.state.facet(editorLang);
