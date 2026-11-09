// Ported from app/vendor/labnoteo/src/partbank/partbankUri.ts:21-169 sha256:885f94992514f98b
// labnoteO 0.140.2, Apache-2.0.
// Changes: LabnotePlugin becomes SampleEnv plus PartbankFeature: handleImportUri(env, feature, params), pickImportFolder(env, …) and deliverReference(env, …). The params no longer come from an Obsidian protocol handler but from a pasted link (partbank/linkCommand.ts parses it into a Record, D14). plugin.t → env.t; new Notice(m) → env.host.notify('info', m), and 'warn' without a duration for the partbank that is not set up here; confirmModal(app, message, label) → env.host.confirm(message, { confirmLabel: label }); pickModal(app, items, { title }) → env.host.pick(items, { title }); plugin.partbank.clientForOrigin → feature.clientForOrigin (the link's server only selects a configured connection); plugin.partbank.notifyError(err, client.kind) → feature.notifyError(err, client); plugin.localSampleFolder() → env.localFolder(); plugin.settings.globalSampleFolder → env.globalFolder(); plugin.host.editTarget() → env.editTarget(); plugin.sampleTrackingFor → env.trackingFor; insertSampleReference is the app port (port/sampleInsert, cell-aware). A vault switch is checked for (D11): handleImportUri takes client.vaultGuard() before the item is fetched and hands it to resolveSampleType and registerPartbankItem, and a cancelled fetch or registration ends quietly with nothing written. A clipboard that refuses the copy is told with t('samples.copyRefused') instead of throwing.
/**
 * `obsidian://labnoteo-import?server=…&type=part&id=…` — the "Send to
 * labnoteo" button in partbank. In the app the link is pasted into
 * "Open labnoteO link" (D14); it is still untrusted input end to end.
 *
 * Any web page can make such a link, so the parameters are validated before
 * anything happens, the `server` only *selects* a connection that is already
 * configured (the key is never sent to an address the link supplies), and the
 * item and where it will be registered are shown for confirmation before a
 * record is written.
 */
import { isPartbankType, type PartbankType } from '@labnoteo/core';
import { isSameSampleFolder } from '@labnoteo/core/lib/sampleStorage';
import { caretBeforeModal } from '@labnoteo/core/lib/caret';
import { t } from '../../i18n/t';
import { NetError, type VaultGuard } from '../../integrations/netIpc';
import type { SampleEnv } from '../../samples/env';
import type { PartbankFeature } from './partbankFeature';
import { catalogSeedNote, noticeForRegistration, registerPartbankItem, resolveSampleType } from './partbankRegister';
import { insertSampleReference } from './sampleInsert';

/** The protocol action this plugin answers. */
export const IMPORT_ACTION = 'labnoteo-import';

/** A `labnoteo-import` request that passed validation. */
export interface PartbankImportRequest {
  server: string;
  type: PartbankType;
  id: string;
}

/** partbank's ids are Mongo ObjectIds; anything else cannot be an item. */
const OBJECT_ID_RE = /^[0-9a-f]{24}$/i;

/**
 * Read the URI parameters, or undefined when any of them is not what it
 * claims to be. Deliberately strict: this is the one entry point a web page
 * can reach.
 */
export function parseImportRequest(params: Record<string, string>): PartbankImportRequest | undefined {
  const server = (params.server ?? '').trim();
  const type = (params.type ?? '').trim().toLowerCase();
  const id = (params.id ?? '').trim();
  if (!server || !isPartbankType(type) || !OBJECT_ID_RE.test(id)) return undefined;
  try {
    const { protocol } = new URL(server);
    if (protocol !== 'http:' && protocol !== 'https:') return undefined;
  } catch {
    return undefined;
  }
  return { server, type, id };
}

/** A request or guard check given up because the vault was switched (D11). */
const isCancelled = (err: unknown): boolean => err instanceof NetError && err.kind === 'cancelled';

/**
 * Handle one `labnoteo-import` link: fetch the item, confirm, register, and
 * either insert the reference at the cursor or put it on the clipboard.
 */
export async function handleImportUri(env: SampleEnv, feature: PartbankFeature, params: Record<string, string>): Promise<void> {
  const request = parseImportRequest(params);
  if (!request) {
    env.host.notify('info', env.t('That partbank link is not something labnoteo can read.'));
    return;
  }
  // The address is only matched against the configured ones; the call goes to
  // what is in settings, never to what the link said.
  const client = feature.clientForOrigin(request.server);
  if (!client) {
    env.host.notify('warn', env.t('That link points at a partbank that is not set up here ({0}).', request.server));
    return;
  }

  const guard: VaultGuard = await client.vaultGuard();
  let item;
  try {
    item = await client.getItem(request.type, request.id);
  } catch (err) {
    if (isCancelled(err) || guard.signal.aborted) return;
    feature.notifyError(err, client);
    return;
  }

  try {
    const type = await resolveSampleType(env, item, { guard });
    if (!type) return;

    const target = await pickImportFolder(env, item.name ?? item.kid ?? request.id, type);
    if (!target) return;

    // Looked up in this experiment too, whichever folder was picked (#270).
    const result = await registerPartbankItem(env, client, item, {
      folder: target.folder,
      type,
      lookIn: env.localFolder(),
      guard,
    });
    if (!result) return;
    noticeForRegistration(env, result, target.chosen ? target.folder : undefined);
    const insertedInto = await deliverReference(
      env,
      result.referenceText,
      result.discarded ? { id: result.id, date: result.discarded } : undefined,
    );
    const seed = catalogSeedNote(env, result, insertedInto);
    if (seed) env.host.notify('info', seed);
  } catch (err) {
    // The vault was switched while partbank answered: nothing was written (D11).
    if (isCancelled(err)) return;
    throw err;
  }
}

/**
 * Where the sample goes: this note's experiment, or Global. Shown rather than
 * assumed, since the user may not have the intended note open. `chosen` is
 * false when there was only one place to offer.
 */
async function pickImportFolder(env: SampleEnv, itemName: string, type: string): Promise<{ folder: string; chosen: boolean } | undefined> {
  const local = env.localFolder();
  const globalFolder = env.globalFolder();
  // Outside an experiment the local folder already *is* the global one.
  if (!globalFolder || isSameSampleFolder(local, globalFolder)) {
    const ok = await env.host.confirm(env.t('Register "{0}" from partbank as a {1} sample in {2}?', itemName, type, local), {
      confirmLabel: env.t('Register'),
    });
    return ok ? { folder: local, chosen: false } : undefined;
  }
  const folder = await env.host.pick(
    [
      { label: env.t('Local: {0}', local), value: local },
      { label: env.t('Global: {0}', globalFolder), value: globalFolder },
    ],
    { title: env.t('Register "{0}" from partbank as a {1} sample where?', itemName, type) },
  );
  return folder === undefined ? undefined : { folder, chosen: true };
}

/**
 * Put the reference where the user can use it: into the open note if they
 * agree, onto the clipboard only when there was no note to ask about. Declining
 * leaves both alone (#284). Returns the note it went into, if any.
 */
export async function deliverReference(
  env: SampleEnv,
  referenceText: string,
  discarded?: { id: string; date: string },
): Promise<string | undefined> {
  const target = env.editTarget();
  if (target && env.trackingFor(target.path)) {
    const used = discarded ? ` ${env.t('{0} was marked discarded on {1}.', discarded.id, discarded.date)}` : '';
    // Read before the confirmation opens: it takes the focus, and the editor
    // then reports the cursor at the start of the note (#544).
    const caret = await caretBeforeModal(target);
    const ok = await env.host.confirm(env.t('Insert {0} into the open note?', referenceText) + used, {
      confirmLabel: env.t('Insert'),
    });
    if (!ok) return undefined;
    await insertSampleReference(env, target, referenceText, caret);
    return target.path;
  }
  try {
    await navigator.clipboard.writeText(referenceText);
  } catch {
    env.host.notify('warn', t('samples.copyRefused', referenceText));
    return undefined;
  }
  env.host.notify('info', env.t('Copied {0} to the clipboard.', referenceText));
  return undefined;
}
