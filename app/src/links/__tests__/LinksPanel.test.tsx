// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '../../i18n/t';
import { linkIndex } from '../linkIndex';
import { LinksPanel } from '../LinksPanel';

const onOpen = vi.fn();
const onCreate = vi.fn();

beforeEach(() => {
  linkIndex.clear();
  onOpen.mockReset();
  onCreate.mockReset();
});

describe('LinksPanel backlinks', () => {
  it('lists backlinks grouped by note with highlighted context, and opens at the line', async () => {
    linkIndex.setFiles(['Home.md', 'notes/a.md', 'notes/b.md']);
    linkIndex.setNote('notes/a.md', 'x\nsee [[Home]] here');
    linkIndex.setNote('notes/b.md', '[[Home|홈]]');
    linkIndex.markReady();
    render(<LinksPanel activePath="Home.md" onOpen={onOpen} onCreate={onCreate} />);
    expect(screen.getByRole('heading', { name: t('links.backlinks', '2') })).toBeTruthy();
    const marks = [...document.querySelectorAll('.links-context mark')].map((m) => m.textContent);
    expect(marks).toEqual(['[[Home]]', '[[Home|홈]]']);
    await userEvent.click(screen.getByText('see', { exact: false }));
    expect(onOpen).toHaveBeenCalledWith('notes/a.md', 1);
  });

  it('shows loading, no note, and none', () => {
    linkIndex.clear();
    const { rerender } = render(<LinksPanel activePath="Home.md" onOpen={onOpen} onCreate={onCreate} />);
    expect(screen.getByText(t('links.loading'))).toBeTruthy();
    linkIndex.setFiles(['Home.md']);
    linkIndex.markReady();
    rerender(<LinksPanel activePath={undefined} onOpen={onOpen} onCreate={onCreate} />);
    expect(screen.getByText(t('links.noNote'))).toBeTruthy();
    rerender(<LinksPanel activePath="Home.md" onOpen={onOpen} onCreate={onCreate} />);
    expect(screen.getByText(t('links.backlinks.none'))).toBeTruthy();
  });

  it('labnote sources are headed by their title, with the folder muted', () => {
    linkIndex.clear();
    linkIndex.setFiles(['Home.md', 'labnote/061_a/README.labnote.md', 'labnote/062_b/README.labnote.md']);
    linkIndex.setNote('labnote/061_a/README.labnote.md', '---\ntitle: 061 PCR 최적화\n---\n[[Home]]');
    linkIndex.setNote('labnote/062_b/README.labnote.md', '[[Home]]');
    linkIndex.markReady();
    render(<LinksPanel activePath="Home.md" onOpen={onOpen} onCreate={onCreate} />);
    const heads = [...document.querySelectorAll('.links-source')].map((b) => [
      b.querySelector('.links-source-name')!.textContent,
      b.querySelector('.links-source-folder')!.textContent,
    ]);
    expect(heads).toEqual([
      ['061 PCR 최적화', 'labnote/061_a'],
      ['README', 'labnote/062_b'],
    ]);
  });

  it('a click on the source header opens the source note', async () => {
    linkIndex.setFiles(['Home.md', 'notes/a.md']);
    linkIndex.setNote('notes/a.md', '[[Home]]');
    linkIndex.markReady();
    render(<LinksPanel activePath="Home.md" onOpen={onOpen} onCreate={onCreate} />);
    await userEvent.click(document.querySelector('.links-source') as HTMLElement);
    expect(onOpen).toHaveBeenCalledWith('notes/a.md');
  });

  it('follows index changes after the first render', async () => {
    linkIndex.setFiles(['Home.md', 'notes/a.md']);
    linkIndex.markReady();
    render(<LinksPanel activePath="Home.md" onOpen={onOpen} onCreate={onCreate} />);
    expect(screen.getByText(t('links.backlinks.none'))).toBeTruthy();
    linkIndex.setNote('notes/a.md', 'go [[Home]]');
    expect(await screen.findByRole('heading', { name: t('links.backlinks', '1') })).toBeTruthy();
  });
});
