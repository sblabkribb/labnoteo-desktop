/**
 * The Links sidebar tab (plan SP4 Task 17, D10): the open note's backlinks.
 * - Backlinks are grouped by source note, sorted by path. The group header is a `.labnote.md` source's
 *   front-matter title when it has one, otherwise its basename; the folder follows, muted.
 * - Each link is one context line with the link part in `<mark>`; a click opens the source at that line.
 * - Outgoing links (Task 18) come from `linkIndex.resolved(activePath)` in document order, deduplicated by target key
 *   (unresolved and unknown links by link-path key). A resolved row opens its target, an unresolved row (marked
 *   "not created") creates the note, and an unknown attachment target is shown plain and is not clickable.
 * - The panel re-renders through `useLinkIndexState` (index readiness, `filesVersion`, `linksVersion`).
 */
import { useMemo } from 'react';
import { t } from '../i18n/t';
import type { ExtractedLink } from './extract';
import { linkIndex, linkPathOf, type Backlink, type ResolvedLink } from './linkIndex';
import { linkKey } from './resolve';
import { useLinkIndexState } from './useLinkIndexState';

export interface LinksPanelProps {
  /** The open note, or undefined when none is open. */
  activePath: string | undefined;
  /** Opens a note; `line` is 0-based. */
  onOpen(path: string, line?: number): void;
  /** Creates the note an unresolved link names (outgoing links, Task 18). */
  onCreate(linkpath: string): void;
}

function folderOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

/** The group header: a labnote note's title, else its basename without `.labnote.md`/`.md`. */
function sourceName(path: string): string {
  const title = linkIndex.title(path)?.trim();
  if (title) return title;
  const base = path.slice(path.lastIndexOf('/') + 1);
  return base.replace(/\.labnote\.md$/i, '').replace(/\.md$/i, '');
}

/** One outgoing row; a resolved target is labelled by its title or basename, as in the backlink headers. */
interface OutgoingRow {
  key: string;
  label: string;
  target: string | null;
  linkpath: string;
  unknown: boolean;
}

/** Deduplicates in document order: resolved links by target key, the rest by link-path key. */
function outgoingRows(resolved: readonly ResolvedLink[]): OutgoingRow[] {
  const seen = new Set<string>();
  const rows: OutgoingRow[] = [];
  for (const { link, target, unknown } of resolved) {
    const linkpath = linkPathOf(link);
    const key = target !== null ? `t:${linkKey(target)}` : `p:${linkKey(linkpath)}`;
    if (target === null && !linkpath) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ key, label: target !== null ? sourceName(target) : linkpath, target, linkpath, unknown });
  }
  return rows;
}

function OutgoingItem({ row, onOpen, onCreate }: { row: OutgoingRow } & Pick<LinksPanelProps, 'onOpen' | 'onCreate'>) {
  if (row.target !== null) {
    const target = row.target;
    return (
      <button type="button" className="links-target" title={target} onClick={() => onOpen(target, undefined)}>
        {row.label}
      </button>
    );
  }
  if (row.unknown) return <span className="links-target links-target-unknown">{row.label}</span>;
  return (
    <button type="button" className="links-target links-target-unresolved" onClick={() => onCreate(row.linkpath)}>
      {row.label}
      <span className="links-unresolved-mark">{t('links.unresolved')}</span>
    </button>
  );
}

function ContextLine({ link, onClick }: { link: ExtractedLink; onClick(): void }) {
  const { context, contextFrom, contextTo } = link;
  return (
    <button type="button" className="links-context" onClick={onClick}>
      {context.slice(0, contextFrom)}
      <mark>{context.slice(contextFrom, contextTo)}</mark>
      {context.slice(contextTo)}
    </button>
  );
}

function BacklinkGroup({ backlink, onOpen }: { backlink: Backlink; onOpen: LinksPanelProps['onOpen'] }) {
  const { source, links } = backlink;
  return (
    <section className="links-group">
      <button type="button" className="links-source" title={source} onClick={() => onOpen(source)}>
        <span className="links-source-name">{sourceName(source)}</span>
        <span className="links-source-folder">{folderOf(source)}</span>
      </button>
      <ul className="links-list">
        {links.map((link) => (
          <li key={`${link.from}:${link.to}`}>
            <ContextLine link={link} onClick={() => onOpen(source, link.line)} />
          </li>
        ))}
      </ul>
    </section>
  );
}

export function LinksPanel({ activePath, onOpen, onCreate }: LinksPanelProps) {
  const state = useLinkIndexState();
  const backlinks = useMemo(
    () => (state.ready && activePath ? linkIndex.backlinks(activePath) : []),
    // The versions stand for the index contents this list was read from.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state, activePath],
  );
  const outgoing = useMemo(
    () => (state.ready && activePath ? outgoingRows(linkIndex.resolved(activePath)) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state, activePath],
  );
  if (!activePath) return <p className="links-empty">{t('links.noNote')}</p>;
  if (!state.ready) return <p className="links-empty">{t('links.loading')}</p>;
  return (
    <div className="links-panel">
      <section className="links-section" aria-labelledby="links-backlinks-heading">
        <h3 id="links-backlinks-heading" className="links-heading">
          {t('links.backlinks', String(backlinks.length))}
        </h3>
        {backlinks.length === 0 ? (
          <p className="links-empty">{t('links.backlinks.none')}</p>
        ) : (
          backlinks.map((b) => <BacklinkGroup key={b.source} backlink={b} onOpen={onOpen} />)
        )}
      </section>
      <section className="links-section links-outgoing" aria-labelledby="links-outgoing-heading">
        <h3 id="links-outgoing-heading" className="links-heading">
          {t('links.outgoing', String(outgoing.length))}
        </h3>
        {outgoing.length === 0 ? (
          <p className="links-empty">{t('links.outgoing.none')}</p>
        ) : (
          <ul className="links-list">
            {outgoing.map((row) => (
              <li key={row.key}>
                <OutgoingItem row={row} onOpen={onOpen} onCreate={onCreate} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
