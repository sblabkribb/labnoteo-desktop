// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { EditorView } from '@codemirror/view';
import { autocompletion } from '@codemirror/autocomplete';
import { completionGuards, wikiReopen } from '../complete';

describe('completionGuards', () => {
  it('reopens after compositionend when any predicate matches', async () => {
    const calls: string[] = [];
    // Mounted in the document: the guard only reopens for a connected view.
    const view = new EditorView({
      doc: '@배지;',
      parent: document.body,
      extensions: [autocompletion({ override: [async () => null] }), completionGuards([() => false, (l) => (calls.push(l), l.startsWith('@'))])],
    });
    view.dispatch({ selection: { anchor: 4 } });
    view.contentDOM.dispatchEvent(new CompositionEvent('compositionend'));
    await new Promise((r) => setTimeout(r, 5));
    expect(calls).toEqual(['@배지;']);
    view.destroy();
  });

  it('wikiReopen matches an open [[ only', () => {
    const view = new EditorView({ doc: '' });
    expect(wikiReopen('see [[Ho', view)).toBe(true);
    expect(wikiReopen('see [[Ho]] x', view)).toBe(false);
    view.destroy();
  });
});
