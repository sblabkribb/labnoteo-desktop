// @vitest-environment jsdom
import { act } from '@testing-library/react';
import { createFakeVault } from '../../__tests__/fakeVault';
import { TauriLabnoteFs } from '../../fs/tauriLabnoteFs';
import { editorAwareFs } from '../editorAwareFs';
import { mountEditor } from './editorHarness';

const P = 'lab/README.md';

function setup(files: Record<string, string>) {
  const vault = createFakeVault(files);
  return { vault, fs: editorAwareFs(new TauriLabnoteFs(vault.invoke)) };
}

describe('editorAwareFs', () => {
  it('read of an open README with unsaved typing returns the buffer in disk encoding', async () => {
    const { vault, fs } = setup({ [P]: '# R\r\n- [ ] one\r\n' });
    const m = mountEditor(vault, P);
    await m.loaded();
    await m.type('- [ ] two\n');
    expect(await fs.read(P)).toBe('# R\r\n- [ ] one\r\n- [ ] two\r\n');
    expect(vault.files()[P]).toBe('# R\r\n- [ ] one\r\n'); // nothing was saved by reading
    m.unmount();
  });

  it('modify of an open note leaves unsaved typing elsewhere intact, and the updater sees disk form', async () => {
    const { vault, fs } = setup({ [P]: '# R\r\nstatus: a\r\n' });
    const m = mountEditor(vault, P);
    await m.loaded();
    await m.type('typed\n');
    let seen = '';
    await act(() =>
      fs.modify(P, (raw) => {
        seen = raw;
        return raw.replace('status: a', 'status: b\r\nnew: 1');
      }),
    );
    expect(seen).toBe('# R\r\nstatus: a\r\ntyped\r\n');
    expect(m.view().state.doc.toString()).toBe('# R\nstatus: b\nnew: 1\ntyped\n');
    expect(vault.files()[P]).toBe('# R\r\nstatus: b\r\nnew: 1\r\ntyped\r\n');
    m.unmount();
  });

  it('write of an open note is a minimal edit of the buffer', async () => {
    const { vault, fs } = setup({ [P]: 'a\nb\nc\n' });
    const m = mountEditor(vault, P);
    await m.loaded();
    await act(() => fs.write(P, 'a\nB\nc\n'));
    expect(m.view().state.doc.toString()).toBe('a\nB\nc\n');
    expect(vault.files()[P]).toBe('a\nB\nc\n');
    m.unmount();
  });

  it('closed notes and the other operations pass through', async () => {
    const { vault, fs } = setup({ 'x.md': 'x', 'y.md': 'y' });
    expect(await fs.read('x.md')).toBe('x');
    await fs.modify('x.md', (s) => `${s}!`);
    await fs.write('n.md', 'new');
    await fs.rename('y.md', 'z.md');
    await fs.trash('n.md');
    expect(await fs.exists('z.md')).toBe(true);
    expect(vault.files()).toEqual({ 'x.md': 'x!', 'z.md': 'y' });
    expect(vault.recycleBin.map((e) => e.path)).toEqual(['n.md']);
  });
});
