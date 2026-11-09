// "bfworkflow: Sync catalogs" (D16): the server catalogs win over the vault's
// resources/workflows/*.json for the same id, vault-only entries are kept, and
// nothing is written without a confirm. Written fresh (D5).
import * as posix from '@labnoteo/core/posix';
import { CATALOG_FILE_NAMES, CATALOG_FILE_SPECS, parseCatalogFile, type CatalogListKey } from '@labnoteo/core';
import { getSeoulDateString } from '@labnoteo/core/lib/dateUtils';
import { t } from '../i18n/t';
import type { CommandContext } from '../labnote/commands/context';
import { CATALOG_DIR, ensureVaultCatalogs } from '../labnote/port/catalogUpdate';
import {
  bfwBase,
  bfwRequest,
  integrationStateWrite,
  NetError,
  vaultGuard,
  type InvokeFn,
} from '../integrations/netIpc';
import { withProgress } from '../integrations/progressStore';
import {
  mapUoCatalog,
  mapWorkflowCatalog,
  mergeById,
  serverCatalogHash,
  type CatalogUo,
  type CatalogWorkflow,
} from './catalogMap';
import { bfwErrorText } from './bfwApp';

interface ServerCatalogs {
  workflows: CatalogWorkflow[];
  hw: CatalogUo[];
  sw: CatalogUo[];
  skipped: number;
  base: string;
}

interface PlannedFile {
  path: string;
  json: Record<string, unknown>;
  listKey: CatalogListKey;
  items: unknown[];
  added: number;
  changed: number;
  kept: number;
}

function cancelled(): NetError {
  return new NetError('cancelled', 'cancelled');
}

/** `promise`, or `cancelled` the moment `signal` aborts. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(cancelled());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(cancelled());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

/** Both catalogs and the base URL, under the progress dialog. Its Cancel, and a vault switch, end the wait. */
async function fetchCatalogs(invoke: InvokeFn | undefined): Promise<ServerCatalogs> {
  return withProgress(
    t('bfw.syncing'),
    async (p) => {
      const [rows, uo, base] = await untilAborted(
        Promise.all([
          bfwRequest({ path: '/api/workflow-catalog' }, invoke),
          bfwRequest({ path: '/api/uo-catalog-json' }, invoke),
          bfwBase(invoke),
        ]),
        p.signal,
      );
      const wf = mapWorkflowCatalog(rows);
      const uos = mapUoCatalog(uo);
      return {
        workflows: wf.workflows,
        hw: uos.hw,
        sw: uos.sw,
        skipped: wf.skipped.length + uos.skipped.length,
        base,
      };
    },
    { cancellable: true },
  );
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Merge one vault file with the server's entries. Vault items without a string id stay, after the merged ones. */
function planFile(
  path: string,
  json: Record<string, unknown>,
  listKey: CatalogListKey,
  vaultItems: unknown[],
  server: ReadonlyArray<{ id: string }>,
): PlannedFile {
  const withId = vaultItems.filter((x): x is { id: string } => isRecord(x) && typeof x.id === 'string');
  const without = vaultItems.filter((x) => !(isRecord(x) && typeof x.id === 'string'));
  const r = mergeById(withId, server);
  return { path, json, listKey, items: [...r.merged, ...without], added: r.added, changed: r.changed, kept: r.kept };
}

/**
 * Run "bfworkflow: Sync catalogs". Fetches both catalogs, writes the app-data cache, merges them into the vault's
 * three catalog files (server wins, vault-only kept, sorted by id) and writes those after a confirm. Failures end
 * as one warning toast; a vault switch on the way writes nothing.
 */
export async function runBfwSyncCatalogs(ctx: CommandContext, invoke?: InvokeFn): Promise<void> {
  const { host } = ctx;
  const connection = ctx.settings.bfwConnection;
  const url = ctx.settings.bfwUrl;
  try {
    const guard = await vaultGuard(invoke);
    const server = await fetchCatalogs(invoke);
    const hash = serverCatalogHash(server);

    await guard.check();
    await integrationStateWrite(
      'bfwCatalogCache',
      JSON.stringify({
        origin: originOf(server.base),
        fetchedAt: new Date().toISOString(),
        hash,
        workflows: server.workflows,
        hw: server.hw,
        sw: server.sw,
      }),
      invoke,
    );

    await guard.check();
    await ensureVaultCatalogs(host);
    const serverFor: Record<string, ReadonlyArray<{ id: string }>> = {
      [CATALOG_FILE_NAMES.workflows]: server.workflows,
      [CATALOG_FILE_NAMES.unitOperationsHw]: server.hw,
      [CATALOG_FILE_NAMES.unitOperationsSw]: server.sw,
    };
    const files: PlannedFile[] = [];
    for (const spec of CATALOG_FILE_SPECS) {
      const path = posix.join(CATALOG_DIR, spec.file);
      let text: string;
      try {
        text = await host.fs.read(path);
      } catch {
        host.notify('warn', t('bfw.catalogBroken', path));
        continue;
      }
      const parsed = parseCatalogFile(text, spec.listKey);
      if (!parsed.ok) {
        host.notify('warn', t('bfw.catalogBroken', path));
        continue;
      }
      files.push(planFile(path, parsed.json, spec.listKey, parsed.items, serverFor[spec.file] ?? []));
    }

    const added = files.reduce((n, f) => n + f.added, 0);
    const changed = files.reduce((n, f) => n + f.changed, 0);
    const kept = files.reduce((n, f) => n + f.kept, 0);
    if (added + changed === 0) {
      host.notify('info', t('bfw.catalogsCurrent'));
      return;
    }
    const ok = await host.confirm(t('bfw.catalogsConfirm', added, changed, kept, server.skipped), {
      confirmLabel: t('bfw.apply'),
    });
    if (!ok) return;

    const meta = { version: `bfworkflow-${hash.slice(0, 12)}`, language: 'en', lastUpdated: getSeoulDateString() };
    for (const f of files) {
      await guard.check();
      await host.fs.write(f.path, `${JSON.stringify({ ...f.json, ...meta, [f.listKey]: f.items }, null, 2)}\n`);
    }
    ctx.refresh();
  } catch (e) {
    if (!(e instanceof NetError)) throw e;
    if (e.kind === 'cancelled') return;
    host.notify('warn', bfwErrorText(e, { connection, url, scope: 'read' }));
  }
}
