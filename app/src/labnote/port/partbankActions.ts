// Ported from app/vendor/labnoteo/src/partbank/partbankActions.ts:16-72 sha256:79319b4fd874f4d4
// Ported from app/vendor/labnoteo/src/externalLink.ts:17-47 sha256:6b10d0e600620c41
// labnoteO 0.140.2, Apache-2.0.
// Changes: LabnotePlugin becomes SampleEnv plus PartbankFeature, and plugin.t → env.t. addPartbankMenuItems(menu, …) becomes partbankMenuItems, which returns the app's MenuItem[] (labnote/ui/menuStore) instead of filling an Obsidian Menu, with no icons; refreshOneLocation is the ported one (env, feature, ref). PartbankSampleRef is re-exported from partbankLocation, where Task 22 put it. openInPartbank takes env and an injectable open (openExternal); the URL is built by the new partbankOpenUrl from the vault settings (web: settings.partbankWebUrl, trimmed, or else source.origin, as plugin.partbank.url('web') || source.origin; desktop: desktopAppLink). openExternalLink becomes the app's openExternal(url, tauriExternalDeps(notify)), which already copies the link to the clipboard on failure; only its partbank failure sentences are kept, put in front of openExternal's own notice (new Notice → env.host.notify), and the console.warn is dropped. The mobile "linked to the partbank app on another PC" refusal (Platform.isDesktopApp) is dropped: the app is desktop only.
/**
 * The partbank entries of the sample context menu and the definition dialog:
 * refresh where a sample is kept, and show it in partbank.
 *
 * Both appear only for a sample that carries a link, so a vault that never
 * touched partbank sees the menus it always did.
 */
import { desktopAppLink, webAppPath, type SampleSource } from '@labnoteo/core';
import { openExternal, tauriExternalDeps } from '../../links/openExternal';
import type { SampleEnv } from '../../samples/env';
import type { AppSettings } from '../settings';
import type { MenuItem } from '../ui/menuStore';
import type { PartbankFeature } from './partbankFeature';
import { refreshOneLocation, type PartbankSampleRef } from './partbankLocation';

export type { PartbankSampleRef };

/** The partbank items of a sample's context menu; none when it has no link. */
export function partbankMenuItems(env: SampleEnv, feature: PartbankFeature, sample: PartbankSampleRef): MenuItem[] {
  const source = sample.record.source;
  if (!source) return [];
  return [
    { label: env.t('Refresh storage location from partbank'), run: () => refreshOneLocation(env, feature, sample) },
    { label: env.t('Open in partbank'), run: () => openInPartbank(env, source) },
  ];
}

/**
 * Where an item is shown in partbank. The web app is reached on the server
 * this vault is set up for (a moved server keeps old links working), or the
 * one the link was made on; the desktop app through its `partbank://` scheme.
 */
export function partbankOpenUrl(settings: AppSettings, source: SampleSource): string {
  if (source.connection === 'web') {
    const origin = ((settings.partbankWebUrl ?? '').trim() || source.origin).replace(/\/+$/, '');
    return `${origin}${webAppPath(source)}`;
  }
  return desktopAppLink(source);
}

/**
 * Show an item in partbank.
 *
 * The web app opens in the browser. The desktop app cannot be reached that
 * way — its no-login session secret is only readable inside its own window, so
 * a browser would land on a login screen — so it is asked through its own
 * `partbank://` scheme, which also starts the app when it is closed. On
 * failure the link goes to the clipboard so it can still be opened by hand.
 */
export async function openInPartbank(env: SampleEnv, source: SampleSource, open: typeof openExternal = openExternal): Promise<void> {
  const failure =
    source.connection === 'web'
      ? env.t('Could not open partbank in the browser.')
      : env.t('Could not open the partbank app. If it is installed, start it once so that it registers its links.');
  await open(
    partbankOpenUrl(env.settings(), source),
    tauriExternalDeps((kind, message) => env.host.notify(kind, `${failure}\n${message}`)),
  );
}
