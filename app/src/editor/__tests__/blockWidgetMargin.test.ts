// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { editorThemeSpec } from '../theme';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { labnoteMarkdown } from '../markdownSyntax';
import { propertiesField } from '../live/properties';

// CodeMirror measures a block widget by its border box: a vertical margin on the widget's root is not counted,
// so every line below it maps clicks to the wrong line. Block widget roots must space themselves with padding.
const spec = editorThemeSpec as unknown as Record<string, Record<string, unknown>>;
const hasMargin = (sel: string) => Object.keys(spec[sel] ?? {}).some((k) => /^margin(Top|Bottom|Block)?$/.test(k) && spec[sel][k] !== '0');

describe('block widget roots', () => {
  it('the properties grid root is the padded wrapper, not the margined box', () => {
    const view = new EditorView({ state: EditorState.create({ doc: '---\na: 1\n---\nx', selection: { anchor: 14 }, extensions: [labnoteMarkdown(), propertiesField] }) });
    const box = view.contentDOM.querySelector('.lno-props')!;
    expect(box).not.toBeNull();
    const root = box.parentElement!;
    expect(root.classList.contains('lno-props-wrap')).toBe(true);
    expect(root.classList.contains('cm-content')).toBe(false);
    view.destroy();
  });
  it.each(['.lno-props', '.lno-props-wrap', '.lno-table-wrap'])('%s has no vertical margin', (sel) => {
    expect(hasMargin(sel)).toBe(false);
  });
});
