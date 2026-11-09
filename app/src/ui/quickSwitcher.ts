import type { CommandContext } from '../labnote/commands/context';
import { linkIndex } from '../links/linkIndex';
import { t } from '../i18n/t';

/** 노트 경로에서 보이는 이름: 마지막 조각에서 .labnote.md / .md 를 뗀다. */
function noteName(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  return base.replace(/\.labnote\.md$/i, '').replace(/\.md$/i, '');
}

/**
 * 빠른 이동(리본의 찾기 단추, Ctrl+O): 보관함의 노트를 이름으로 골라 연다. 목록은 링크 색인의 파일(이미 보관함 전체를 안다).
 * 모양과 순위는 UI 재설계 Task 12 가 다듬는다.
 */
export async function runQuickSwitcher(ctx: CommandContext): Promise<void> {
  const notes = linkIndex
    .files()
    .filter((p) => /\.md$/i.test(p))
    .sort((a, b) => a.localeCompare(b));
  if (notes.length === 0) {
    ctx.host.notify('info', t('quickSwitcher.empty'));
    return;
  }
  const items = notes.map((path) => {
    const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    return { label: noteName(path), description: dir || undefined, keywords: [path], value: path };
  });
  const chosen = await ctx.host.pick(items, { title: t('quickSwitcher.title'), placeholder: t('quickSwitcher.placeholder') });
  if (chosen !== undefined) await ctx.openFile(chosen);
}
