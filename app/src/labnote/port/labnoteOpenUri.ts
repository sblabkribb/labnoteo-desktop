// Ported from app/vendor/labnoteo/src/labnoteOpenUri.ts:13-89 sha256:d5fe31ea79463946
// labnoteO 0.140.2, Apache-2.0.
// Changes: handleOpenUri takes a SampleEnv instead of the plugin, and its params come from a pasted link (partbank/linkCommand.ts, D14) instead of an Obsidian protocol handler. Obsidian picked the vault from `vault`; the app has one open vault, so linkCommand refuses a link that names another one before calling this (vault_current().name for app.vault.getName()). plugin.t → env.t; new Notice(m) → env.host.notify('info', m), without the duration; plugin.settings.customSampleTypes → env.settings().customSampleTypes; app.vault.getAbstractFileByPath + `instanceof TFile` and cachedRead → env.fs.exists + env.fs.read, a path that cannot be read as a file being "not found"; plugin.host.openFile(path, at) → env.openFile(path, at); sampleListHeaders(plugin) → the app port's sampleListHeaders(env).
/**
 * `obsidian://labnoteo-open?vault=…&file=…&type=…&sample=…&heading=…`: the link
 * partbank's detail pages put on each note that uses an item. It only opens a
 * note that already exists, at the sample's reference, and writes nothing, so
 * a web page making it can do no harm.
 */
import { findSampleUsageSpots } from '@labnoteo/core/lib/sampleStorage';
import { getSampleDisplayMeta } from '@labnoteo/core/lib/sampleUtils';
import type { SampleEnv } from '../../samples/env';
import { sampleListHeaders } from './sampleListTable';

export const OPEN_ACTION = 'labnoteo-open';

const MAX_PATH = 1024;
const MAX_SAMPLE_ID = 200;
const MAX_HEADING = 300;

export interface OpenRequest {
  file: string;
  /** Present together, or not at all. */
  sample?: { type: string; id: string };
  heading?: string;
}

/**
 * The note (and sample) a link asks for, or undefined when it is not a plain
 * vault-relative Markdown path or names a sample type this vault does not have.
 * `types` are the vault's sample types; the type is matched case-insensitively
 * and returned as the vault spells it.
 */
export function parseOpenRequest(params: Record<string, string | undefined>, types: readonly string[]): OpenRequest | undefined {
  const file = (params.file ?? '').trim().replace(/\\/g, '/');
  if (!file || file.length > MAX_PATH || !file.toLowerCase().endsWith('.md')) return undefined;
  if (file.startsWith('/') || /^[a-z]:/i.test(file) || file.split('/').some((part) => part === '..' || part === '.')) {
    return undefined;
  }

  const rawType = (params.type ?? '').trim();
  const rawId = (params.sample ?? '').trim();
  let sample: OpenRequest['sample'];
  if (rawType || rawId) {
    const type = types.find((t) => t.toLowerCase() === rawType.toLowerCase());
    if (!type || !rawId || rawId.length > MAX_SAMPLE_ID) return undefined;
    sample = { type, id: rawId };
  }

  const heading = (params.heading ?? '').trim();
  if (heading.length > MAX_HEADING) return undefined;
  return { file, ...(sample ? { sample } : {}), ...(heading ? { heading } : {}) };
}

/**
 * Where to put the cursor: the sample's reference under `heading` when there is
 * one, else its first reference, else the top of the note.
 */
export function openPosition(text: string, request: OpenRequest, headers: ReadonlyArray<readonly string[]>): { line: number; ch: number } {
  if (!request.sample) return { line: 0, ch: 0 };
  const spots = findSampleUsageSpots([{ path: request.file, text }], request.sample.type, request.sample.id, headers);
  const spot = (request.heading && spots.find((s) => s.heading === request.heading)) || spots[0];
  return spot ? { line: spot.line, ch: spot.ch } : { line: 0, ch: 0 };
}

export async function handleOpenUri(env: SampleEnv, params: Record<string, string>): Promise<void> {
  const request = parseOpenRequest(params, getSampleDisplayMeta(env.settings().customSampleTypes).types);
  if (!request) {
    env.host.notify('info', env.t('That note link is not something labnoteo can read.'));
    return;
  }
  let text: string;
  try {
    if (!(await env.fs.exists(request.file))) throw new Error('missing');
    text = await env.fs.read(request.file);
  } catch {
    env.host.notify('info', env.t('Could not find the note: {0}', request.file));
    return;
  }
  await env.openFile(request.file, openPosition(text, request, sampleListHeaders(env)));
}
