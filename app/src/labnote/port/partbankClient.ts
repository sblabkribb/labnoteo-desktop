// Ported from app/vendor/labnoteo/src/partbank/client.ts:25-366 sha256:b134c4a0c1eecc51
// labnoteO 0.140.2, Apache-2.0.
// Changes: requestUrl becomes netIpc.partbankRequest, so Rust builds `<url>/api/v1<path>` from the stored settings and adds X-API-Key from the keychain; the webview never holds the address it calls or the key. PartbankConnectionConfig loses url and apiKey and keeps { kind, origin }; origin is for display and matching only. The constructor takes (kind, origin, invoke?). withTimeout/TIMEOUT_MS are dropped (Rust enforces 15 s) and waitForWebSlot/WEB_CALL_GAP_MS are dropped (Rust paces web calls through one shared gate). The query goes as [key, value] pairs. Every NetError kind maps to a PartbankErrorKind through toPartbankError (cancelled is rethrown as is); PartbankErrorKind gains notConfigured, redirected, insecure, keychain, tooLarge and badRequest, and PartbankError gains location. statusKind and LIST_PAGE_SIZE are exported. connectionForSource/connectionForOrigin match on origin instead of url.
/**
 * Talking to partbank: the desktop app on this PC, or a web server.
 *
 * The key is only ever sent to an address stored in settings, and in this app
 * the webview never sees either: Rust reads the address from the vault's
 * stored settings and the key from Windows Credential Manager. A note, a
 * catalog or a `labnoteo-import` link may name a server, but it only *selects*
 * a connection, it never supplies the address.
 */
import {
  isDesktopOrigin,
  normalizeOrigin,
  resourceSegment,
  typeFromSearchEntity,
  type PartbankConnection,
  type PartbankItem,
  type PartbankSearchEntity,
  type PartbankStock,
  type PartbankType,
  type SampleSource,
} from '@labnoteo/core';
import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { NetError, partbankRequest, toNetError, type InvokeFn } from '../../integrations/netIpc';

/** A configured connection: which one it is and where it points (for display and matching). */
export interface PartbankConnectionConfig {
  kind: PartbankConnection;
  origin: string;
}

/** Why a call did not produce data, in the terms the user can act on. */
export type PartbankErrorKind =
  | 'offline'
  | 'unauthorized'
  | 'forbidden'
  | 'notFound'
  | 'rateLimited'
  | 'timeout'
  | 'server'
  /** The address answered, but not the way partbank's API does (#278). */
  | 'notPartbank'
  /** No address or no key is saved for this connection, or the address is not a URL. */
  | 'notConfigured'
  /** The server answered with a redirect; the key was not sent on. */
  | 'redirected'
  /** The key would have gone over plain http to another machine. */
  | 'insecure'
  /** Windows Credential Manager could not be read. */
  | 'keychain'
  /** The answer was larger than the app accepts. */
  | 'tooLarge'
  /** The app asked for something it should not have: a bug, not the user's doing. */
  | 'badRequest';

export class PartbankError extends Error {
  constructor(
    readonly kind: PartbankErrorKind,
    readonly status: number | undefined,
    message: string,
    /** For `redirected`: where the server pointed. */
    readonly location?: string,
  ) {
    super(message);
    this.name = 'PartbankError';
  }
}

/** A row of `POST /search/global`. */
export interface PartbankSearchHit extends PartbankItem {
  ownedByMe: boolean;
  sharingLevel: string | null;
}

/** {@link PartbankClient.searchGlobal} result. */
export interface PartbankSearchResult {
  hits: PartbankSearchHit[];
  /** How many items of each type matched in all, when the server says. */
  typeCounts?: Partial<Record<PartbankType, number>>;
}

/** How many rows of each type a search returns. */
export const SEARCH_LIMIT = 10;

/** Page size of the catalog download; the endpoint allows up to 1000. */
export const LIST_PAGE_SIZE = 200;

/** One reference of a note, as `PUT /labnoteo/usages/notes` takes it. */
export interface NoteUsageRef {
  type: PartbankType;
  id: string;
  sample_type: string;
  sample_id: string;
  alias?: string;
  headings: string[];
}

/** A note's whole set of references; no refs removes the note's rows. */
export interface NoteUsage {
  note_path: string;
  note_title: string;
  experiment: string | null;
  refs: NoteUsageRef[];
}

interface RequestOpts {
  method?: 'GET' | 'POST' | 'PUT';
  body?: unknown;
  /** Query string parameters, already decoded. */
  query?: Record<string, string | number | boolean>;
}

export class PartbankClient {
  private readonly invoke: InvokeFn;

  constructor(
    readonly kind: PartbankConnection,
    /** The configured address, for display and `serverKey` only: Rust calls the stored one. */
    readonly origin: string,
    invoke: InvokeFn = tauriInvoke,
  ) {
    this.invoke = invoke;
  }

  /** The signed-in user's name, which is what "test connection" reports. */
  async whoAmI(): Promise<string> {
    const me = await this.request<{ username?: unknown; email?: unknown } | null>('/auth/me');
    const name = [me?.username, me?.email].find((v): v is string => typeof v === 'string' && Boolean(v.trim()));
    // Any web server can answer 200 with JSON; partbank's account call names the account.
    if (!name) throw new PartbankError('notPartbank', 200, 'no account in the response');
    return name.trim();
  }

  /**
   * Substring search across partbank, the same call its own web app makes,
   * narrowed to the key owner's own items and those shared with their groups:
   * a public item from another lab is not something they keep a tube of.
   * `limit` is per entity, so asking for three entities can return three times
   * as many rows. `typeCounts` is how many items of each type matched in all
   * (#561), so a list cut at `limit` can say so; an older server sends none.
   */
  async searchGlobal(
    query: string,
    entities: readonly PartbankSearchEntity[],
    limit = SEARCH_LIMIT,
  ): Promise<PartbankSearchResult> {
    if (!query.trim() || entities.length === 0) return { hits: [] };
    const res = await this.request<{ results?: unknown[]; type_counts?: unknown } | null>('/search/global', {
      method: 'POST',
      body: { query: query.trim(), types: [...entities], limit, exclude_public: true },
    });
    const hits = (res?.results ?? []).flatMap((row) => {
      const hit = toSearchHit(row);
      // A server older than `exclude_public` ignores it and still sends public items.
      return hit && (hit.ownedByMe || hit.sharingLevel !== 'public') ? [hit] : [];
    });
    const typeCounts = toTypeCounts(res?.type_counts);
    return typeCounts ? { hits, typeCounts } : { hits };
  }

  /** One item in full. Only a Mongo ObjectId works here; a KID gives a 404. */
  async getItem(type: PartbankType, id: string): Promise<PartbankItem> {
    const raw = await this.request<Record<string, unknown>>(`/${resourceSegment(type)}/${id}`);
    return toItem(type, raw) ?? { type, id };
  }

  /** The stocks of an item that this key's owner can see. */
  async getStocks(type: PartbankType, id: string): Promise<PartbankStock[]> {
    const res = await this.request<{ items?: PartbankStock[] } | null>(`/stock-box/by-resource/${type}/${id}`);
    return Array.isArray(res?.items) ? res.items : [];
  }

  /**
   * Every item of one type in the key owner's own workspace, walking the pages.
   * Without a search term the endpoint lists only what they own, so items other
   * people share with their groups stay out. `devices` already excludes plasmids and
   * the generated members of a combinatorial library.
   */
  async listAll(type: PartbankType, onPage?: (count: number) => void): Promise<PartbankItem[]> {
    const out: PartbankItem[] = [];
    for (let skip = 0; ; skip += LIST_PAGE_SIZE) {
      const res = await this.request<{ items?: unknown[]; total?: number } | null>(
        `/workspace/${resourceSegment(type)}`,
        { query: { skip, limit: LIST_PAGE_SIZE, include_components: false } },
      );
      const items = Array.isArray(res?.items) ? res.items : [];
      for (const row of items) {
        const item = toItem(type, row);
        if (item) out.push(item);
      }
      onPage?.(out.length);
      if (items.length < LIST_PAGE_SIZE) return out;
      // A server that ignores `skip` would loop forever otherwise.
      if (typeof res?.total === 'number' && out.length >= res.total) return out;
    }
  }

  /**
   * Replace this labnoteo client's rows of each note on the server, which
   * shows them on the item pages to the key owner only. Items the owner
   * neither owns nor has shared with their groups come back as skipped.
   */
  async putNoteUsages(body: {
    client_id: string;
    generation: string;
    vault_name: string;
    notes: NoteUsage[];
  }): Promise<{ stored: number; skipped: unknown[] }> {
    return this.request('/labnoteo/usages/notes', { method: 'PUT', body });
  }

  /** Drop this client's rows sent under any other generation. */
  async pruneNoteUsages(body: { client_id: string; generation: string }): Promise<{ deleted: number }> {
    return this.request('/labnoteo/usages/prune', { method: 'POST', body });
  }

  private async request<T>(path: string, opts: RequestOpts = {}): Promise<T> {
    const query = opts.query
      ? Object.entries(opts.query).map(([k, v]): [string, string] => [k, String(v)])
      : undefined;
    let res: { status: number; json: unknown };
    try {
      res = await partbankRequest(
        { connection: this.kind, method: opts.method ?? 'GET', path, query, body: opts.body },
        this.invoke,
      );
    } catch (err) {
      if (err instanceof PartbankError) throw err;
      const net = toNetError(err);
      if (net.kind === 'cancelled') throw net;
      throw toPartbankError(net);
    }
    // Rust turns a non-2xx answer into a `status` error; read one handed back as data the same way.
    if (res.status >= 200 && res.status < 300) return res.json as T;
    throw new PartbankError(statusKind(res.status), res.status, `status ${res.status}`);
  }
}

export function statusKind(status: number): PartbankErrorKind {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'notFound';
  if (status === 429) return 'rateLimited';
  if (status === 0) return 'offline';
  return 'server';
}

/**
 * Rust's `NetError` in partbank's terms. The message never carries Rust's own
 * text: what the user reads is made from `kind`. `cancelled` is not a partbank
 * failure, so callers rethrow it before getting here; it reads as `offline`.
 */
export function toPartbankError(e: NetError): PartbankError {
  switch (e.kind) {
    case 'offline':
    case 'tls':
      return new PartbankError('offline', e.status, e.kind);
    case 'timeout':
      return new PartbankError('timeout', e.status, 'timed out');
    case 'notJson':
      // A login page or a site's front page, not partbank's API.
      return new PartbankError('notPartbank', e.status, 'malformed response');
    case 'status': {
      const status = e.status ?? 0;
      return new PartbankError(statusKind(status), status, (e.body ?? '').slice(0, 200));
    }
    case 'keyMissing':
    case 'notConfigured':
    case 'invalidUrl':
      return new PartbankError('notConfigured', e.status, e.kind);
    case 'redirect':
      return new PartbankError('redirected', e.status, 'redirected', e.location);
    case 'insecure':
      return new PartbankError('insecure', e.status, 'insecure');
    case 'keychain':
      return new PartbankError('keychain', e.status, 'keychain');
    case 'tooLarge':
      return new PartbankError('tooLarge', e.status, 'too large');
    case 'forbiddenPath':
    case 'badInput':
    case 'remote':
    case 'noResult':
    case 'cancelled':
    default:
      // An app bug: log which, never the body.
      console.warn(`partbank request refused: ${e.kind}`);
      return new PartbankError('badRequest', e.status, e.kind);
  }
}

function str(row: Record<string, unknown>, key: string): string | null {
  const v = row[key];
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** A list or detail row as an item, or undefined when it has no usable id. */
function toItem(type: PartbankType, row: unknown): PartbankItem | undefined {
  if (!row || typeof row !== 'object') return undefined;
  const r = row as Record<string, unknown>;
  const id = str(r, 'id');
  if (!id) return undefined;
  return {
    type,
    id,
    kid: str(r, 'kid'),
    name: str(r, 'name'),
    description: str(r, 'description'),
    moleculeType: str(r, 'molecule_type'),
  };
}

/** The search's `type_counts`, keyed by the type a link stores, or undefined without one. */
function toTypeCounts(value: unknown): Partial<Record<PartbankType, number>> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out: Partial<Record<PartbankType, number>> = {};
  for (const [entity, count] of Object.entries(value)) {
    const type = typeFromSearchEntity(entity);
    if (type && typeof count === 'number' && Number.isFinite(count)) out[type] = count;
  }
  return out;
}

function toSearchHit(row: unknown): PartbankSearchHit | undefined {
  if (!row || typeof row !== 'object') return undefined;
  const r = row as Record<string, unknown>;
  const entity = str(r, 'type');
  const id = str(r, 'id');
  if (!entity || !id) return undefined;
  const type = typeFromSearchEntity(entity);
  if (!type) return undefined;
  return {
    type,
    id,
    kid: str(r, 'kid'),
    name: str(r, 'name'),
    description: str(r, 'description'),
    moleculeType: str(r, 'molecule_type'),
    ownedByMe: r.owner_is_me === true,
    sharingLevel: str(r, 'sharing_level'),
  };
}

/**
 * The connection a stored link belongs to, or undefined when none is
 * configured for it. Desktop links match by kind alone (the app's port moves),
 * web links by origin, so an item from another server is not fetched from ours.
 */
export function connectionForSource(
  source: SampleSource,
  connections: readonly PartbankConnectionConfig[],
): PartbankConnectionConfig | undefined {
  return connections.find((c) => {
    if (c.kind !== source.connection) return false;
    if (c.kind === 'desktop') return true;
    return normalizeOrigin(c.origin) === normalizeOrigin(source.origin);
  });
}

/**
 * The connection a `labnoteo-import` link names, if any. The link supplies an
 * origin to *match*, never an address to call: the key would otherwise go to
 * whoever sent the link.
 */
export function connectionForOrigin(
  origin: string,
  connections: readonly PartbankConnectionConfig[],
): PartbankConnectionConfig | undefined {
  const wanted = normalizeOrigin(origin);
  if (!wanted) return undefined;
  const desktop = isDesktopOrigin(origin);
  return connections.find((c) => (desktop ? c.kind === 'desktop' : normalizeOrigin(c.origin) === wanted));
}
