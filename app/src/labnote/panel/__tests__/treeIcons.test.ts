import { readFileSync } from 'node:fs';
import { buildExperimentTree, buildWorkflowTree, type ExperimentEntry, type TreeNode } from '@labnoteo/core';
import { ICON_NAMES } from '../../../ui/Icon';
import { TREE_ICONS, displayName, fileKind, hasViewer, isNotePath, treeIcon, type FileKind } from '../treeIcons';

function icons(nodes: readonly TreeNode[], out = new Set<string>()): Set<string> {
  for (const n of nodes) {
    if (n.icon) out.add(n.icon);
    icons(n.children ?? [], out);
  }
  return out;
}

describe('TREE_ICONS', () => {
  it('every core icon name used by buildExperimentTree and buildWorkflowTree maps to a Lucide icon', () => {
    const e = (folder: string, more: Partial<ExperimentEntry> = {}): ExperimentEntry => ({ folder, ...more });
    const entries = [
      e('labnote/001_A', { status: 'planned' }),
      e('labnote/002_B', { status: 'bogus' }),
      e('labnote/003_C'),
      e('labnote/004_D', { discuss: true, status: 'failed' }),
      e('labnote/005_E', { frontMatterError: 'bad yaml' }),
      e('labnote/006_F', { markers: 2, project: 'P', authors: ['K'] }),
    ];
    const used = new Set<string>();
    for (const g of ['status', 'project', 'author', 'discuss'] as const) icons([buildExperimentTree(entries, {}, g)], used);
    const op = { id: 'UHW010', name: 'Op', description: 'd', equipment: 'x' };
    icons(
      buildWorkflowTree({
        workflows: [{ id: 'WD010', name: 'W', description: 'd', category: 'Design' } as never],
        hwUnitOps: [op as never],
        swUnitOps: [{ ...op, id: 'USW010', equipment: undefined, software: 's' } as never],
      }),
      used,
    );
    expect([...used].sort()).toEqual(
      ['beaker', 'comment-discussion', 'file', 'folder', 'symbol-class', 'symbol-function', 'symbol-method', 'warning'].sort(),
    );
    for (const name of used) expect(ICON_NAMES, name).toContain(treeIcon(name));
    for (const name of Object.values(TREE_ICONS)) expect(ICON_NAMES).toContain(name);
    expect(treeIcon('no-such-icon')).toBeUndefined();
    expect(treeIcon(undefined)).toBeUndefined();
  });

  it('a folder shows folder-open while it is expanded', () => {
    expect(treeIcon('folder', false)).toBe('folder');
    expect(treeIcon('folder', true)).toBe('folder-open');
    expect(treeIcon('note', true)).toBe('file-text');
  });

  it('maps every file kind to its icon (spec 4.2)', () => {
    const want: Record<FileKind, string> = {
      folder: 'folder',
      experiment: 'flask-conical',
      readme: 'flask-conical',
      workflow: 'workflow',
      note: 'file-text',
      image: 'image',
      sheet: 'sheet',
      pdf: 'file-type',
      json: 'braces',
      other: 'paperclip',
    };
    for (const [kind, icon] of Object.entries(want)) expect(treeIcon(kind), kind).toBe(icon);
  });

  it('the CSS glyph rules are gone: icons are Lucide SVGs, not content: glyphs', () => {
    const css = readFileSync('src/styles/tree.css', 'utf-8');
    expect(css).not.toMatch(/\.ti-[a-z-]+::before/);
    expect(css).not.toMatch(/content:\s*"[▾▸⚗▣▤⚠✎◆◇•]"/u);
  });
});

describe('fileKind', () => {
  it('tells folders, experiments, READMEs, workflows and notes apart by path', () => {
    expect(fileKind('labnote', true)).toBe('folder');
    expect(fileKind('labnote/001_PCR', true)).toBe('experiment');
    expect(fileKind('labnote/001_PCR/images', true)).toBe('folder');
    expect(fileKind('labnote/001_PCR/README.labnote.md')).toBe('readme');
    expect(fileKind('labnote/001_PCR/01_WD010_Design.labnote.md')).toBe('workflow');
    expect(fileKind('labnote/001_PCR/README.md')).toBe('note');
    expect(fileKind('ideas.labnote.md')).toBe('note');
    expect(fileKind('Daily/2026-11-10.md')).toBe('note');
  });

  it('sorts attachments by extension, any case', () => {
    for (const n of ['a.png', 'b.JPG', 'c.jpeg', 'd.gif', 'e.webp', 'f.bmp', 'g.avif', 'h.svg']) expect(fileKind(n), n).toBe('image');
    for (const n of ['a.csv', 'b.TSV', 'c.xlsx', 'd.xls']) expect(fileKind(n), n).toBe('sheet');
    expect(fileKind('paper.PDF')).toBe('pdf');
    expect(fileKind('resources/workflows/catalog.json')).toBe('json');
    for (const n of ['a.docx', 'b.zip', 'noext', '.hidden']) expect(fileKind(n), n).toBe('other');
  });

  it('only images and sheets have an in-app viewer', () => {
    expect(hasViewer('image')).toBe(true);
    expect(hasViewer('sheet')).toBe(true);
    for (const k of ['pdf', 'json', 'other', 'note', 'folder'] as const) expect(hasViewer(k), k).toBe(false);
  });

  it('isNotePath is any .md file', () => {
    expect(isNotePath('a/b.md')).toBe(true);
    expect(isNotePath('a/b.labnote.MD')).toBe(true);
    expect(isNotePath('a/b.png')).toBe(false);
    expect(isNotePath('a/md')).toBe(false);
  });
});

describe('displayName', () => {
  it('drops .labnote.md, then .md, and keeps every other extension', () => {
    expect(displayName('01_WD010_Design.labnote.md')).toBe('01_WD010_Design');
    expect(displayName('README.labnote.md')).toBe('README');
    expect(displayName('Plan.MD')).toBe('Plan');
    expect(displayName('photo.png')).toBe('photo.png');
    expect(displayName('labnote')).toBe('labnote');
    expect(displayName('.md')).toBe('.md');
    expect(displayName('.labnote.md')).toBe('.labnote.md');
  });
});
