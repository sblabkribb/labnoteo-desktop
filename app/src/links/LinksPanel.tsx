/**
 * The Links sidebar tab (plan SP4 Task 17, D10): the open note's backlinks.
 * - Backlinks are grouped by source note, sorted by path. The group header is a `.labnote.md` source's
 *   front-matter title when it has one, otherwise its basename; the folder follows, muted.
 * - Each link is one context line with the link part in `<mark>`; a click opens the source at that line.
 * - Outgoing links (Task 18) come from `linkIndex.resolved(activePath)` in document order, deduplicated by target key
 *   (unresolved and unknown links by link-path key). A resolved row opens its target, an unresolved row (marked
 *   "not created") creates the note, and an unknown attachment target is shown plain and is not clickable.
 * - Unlinked mentions (Task 19) are collapsed in a `<details>`; the search starts on the first open. Each mention
 *   has a Link button that rewrites that one mention through `processNote`, then searches again. The button is not
 *   shown when the target has no link text from that source (`linktextFor` is null).
 * - The panel re-renders through `useLinkIndexState` (index readiness, `filesVersion`, `linksVersion`).
 */
import { useCallback, useMemo, useRef, useState, type SyntheticEvent } from 'react';
import { t } from '../i18n/t';
import type { CommandContext } from '../labnote/commands/context';
import { runCommand } from '../labnote/commands/runCommand';
import { processNote } from '../labnote/openNotes';
import { searchNotes } from '../search/indexApi';
import type { ExtractedLink } from './extract';
import { linkIndex, linkPathOf, type Backlink, type ResolvedLink } from './linkIndex';
import { linkMention, MENTION_LIMIT, unlinkedMentions, type Mention, type MentionResult } from './mentions';
import { linkKey } from './resolve';
import { useLinkIndexState } from './useLinkIndexState';

export interface LinksPanelProps {
  /** The open note, or undefined when none is open. */
  activePath: string | undefined;
  /** Opens a note; `line` is 0-based. */
  onOpen(path: string, line?: number): void;
  /** Creates the note an unresolved link names (outgoing links, Task 18). */
  onCreate(linkpath: string): void;
  /** The command context for reading notes and the Link action; undefined before a vault is open. */
  ctx: CommandContext | undefined;
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

function ContextLine({
  link,
  onClick,
}: {
  link: Pick<ExtractedLink, 'context' | 'contextFrom' | 'contextTo'>;
  onClick(): void;
}) {
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

/** The target's aliases and (labnote) title, from the link index. */
function metaOf(target: string): { aliases: string[]; title?: string } {
  const key = linkKey(target);
  const aliases = linkIndex
    .aliases()
    .filter((a) => linkKey(a.path) === key)
    .map((a) => a.alias);
  const title = linkIndex.title(target);
  return title === undefined ? { aliases } : { aliases, title };
}

function MentionItem({
  source,
  mention,
  linktext,
  onOpen,
  onLink,
}: {
  source: string;
  mention: Mention;
  linktext: string | null;
  onOpen: LinksPanelProps['onOpen'];
  onLink(mention: Mention, linktext: string): void;
}) {
  return (
    <li className="links-mention">
      <ContextLine link={mention} onClick={() => onOpen(source, mention.line)} />
      {linktext !== null && (
        <button type="button" className="links-mention-link" onClick={() => onLink(mention, linktext)}>
          {t('links.unlinked.link')}
        </button>
      )}
    </li>
  );
}

function UnlinkedMentions({ target, ctx, onOpen }: { target: string; ctx: CommandContext; onOpen: LinksPanelProps['onOpen'] }) {
  const [result, setResult] = useState<MentionResult | null>(null);
  const [started, setStarted] = useState(false);
  const run = useRef(0);

  const search = useCallback(async () => {
    const id = ++run.current;
    try {
      const out = await unlinkedMentions(target, {
        search: (q, limit) => searchNotes(q, limit),
        read: (p) => ctx.host.fs.read(p),
        meta: metaOf(target),
      });
      if (id === run.current) setResult(out);
    } catch (err) {
      if (id !== run.current) return;
      setResult({ groups: [], truncated: false });
      await runCommand(ctx, () => Promise.reject(err));
    }
  }, [target, ctx]);

  const onToggle = (e: SyntheticEvent<HTMLDetailsElement>) => {
    if (!e.currentTarget.open || started) return;
    setStarted(true);
    void search();
  };

  const onLink = (source: string, mention: Mention, linktext: string) => {
    void (async () => {
      await runCommand(ctx, () => processNote(ctx.host.fs, source, (text) => linkMention(text, mention, linktext)));
      await search();
    })();
  };

  const resolver = linkIndex.resolver();
  return (
    <details className="links-section links-unlinked" onToggle={onToggle}>
      <summary className="links-heading">{t('links.unlinked')}</summary>
      {result === null ? (
        started && <p className="links-empty">{t('links.loading')}</p>
      ) : (
        <>
          {result.groups.length === 0 && <p className="links-empty">{t('links.unlinked.none')}</p>}
          {result.groups.map(({ source, mentions }) => {
            const linktext = resolver.linktextFor(target, source);
            return (
              <section className="links-group" key={source}>
                <button type="button" className="links-source" title={source} onClick={() => onOpen(source)}>
                  <span className="links-source-name">{sourceName(source)}</span>
                  <span className="links-source-folder">{folderOf(source)}</span>
                </button>
                <ul className="links-list">
                  {mentions.map((m) => (
                    <MentionItem
                      key={`${m.from}:${m.to}`}
                      source={source}
                      mention={m}
                      linktext={linktext}
                      onOpen={onOpen}
                      onLink={(mention, lt) => onLink(source, mention, lt)}
                    />
                  ))}
                </ul>
              </section>
            );
          })}
          {result.truncated && <p className="links-empty">{t('links.unlinked.more')}</p>}
        </>
      )}
    </details>
  );
}

export function LinksPanel({ activePath, onOpen, onCreate, ctx }: LinksPanelProps) {
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
      {ctx && <UnlinkedMentions key={activePath} target={activePath} ctx={ctx} onOpen={onOpen} />}
    </div>
  );
}
