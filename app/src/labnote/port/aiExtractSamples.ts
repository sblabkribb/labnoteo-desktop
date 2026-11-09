// Ported from app/vendor/labnoteo/src/llm/commands.ts:751-995 sha256:9bb886c45d2ff54f
// labnoteO 0.140.2, Apache-2.0.
// Changes: LabnotePlugin → AiEnv (ai/aiEnv.ts); plugin.host.editTarget() → env.ctx.host.editTarget() (the app EditTarget over the open editor); plugin.t → env.host.t (coreT, the plugin keys); new Notice(m) → env.host.notify('info', m); complete comes from port/aiCommon.ts (Task 31) and returns a ChatResult, so its content is read off it, and 'Configure an AI provider in settings first.' is complete's overrideOr('ai.configureFirst') (D21). getSampleDisplayMeta(plugin.settings.customSampleTypes).types → env.sampleEnv().types() (the same list); plugin.settings.globalSampleFolder → env.sampleEnv().globalFolder() (normalised); plugin.fs → env.sampleEnv().fs (safeRegistryFs over the recycle bin, D13). toolContext(plugin) → toolContext(env), whose fs is env.sampleEnv().fs, wrapped here so a write the guard refuses with RegistryUnreadableError (a conflicted registry) is remembered: nothing is written to that registry, and the end notice is followed by one host.notify('warn', t('samples.registryUnreadable', path)) per such registry instead of the vendor's silent skip. A vaultGuard() is taken before the model is asked (D11): every registry-changing fs call of the tools (write, modify, mkdir, remove, rmdir, and writeNote through toolContext's beforeWrite) awaits guard.check() first, and the creations stop, without a notice, once a check failed or the guard's signal is aborted. After the creations, env.sampleEnv().changed(the written registries) runs (vendor: the tool's own refresh), but not once the vault was switched (those paths would be read in the new vault). The final Notice(…, 15000) → host.notify('warn') when aliases were renamed, and 'info' otherwise. The prompt, the 6000-char cap and the notice texts are the vendor's.
import { createLabnoteTools, runTool } from '@labnoteo/core';
import { canonicalSampleType, normalizeSampleId, toSampleAlias as toAlias } from '@labnoteo/core/lib/sampleUtils';
import {
  findSampleReferenceSpans,
  loadSamplesByType,
  noteLabsamplesFolder,
  type SampleRecord,
} from '@labnoteo/core/lib/sampleStorage';
import type { AiEnv } from '../../ai/aiEnv';
import { t as appT } from '../../i18n/t';
import { vaultGuard } from '../../integrations/netIpc';
import { RegistryUnreadableError } from '../../samples/env';
import { complete, toolContext } from './aiCommon';

interface ExtractedSample {
  type?: string;
  id?: string;
  alias?: string;
  description?: string;
  location?: string;
}

/**
 * Pull a JSON array out of a model's reply.
 *
 * Models ignore "respond with ONLY JSON" often enough that this has to cope
 * with code fences and surrounding prose; anything it cannot parse becomes an
 * empty list, which the caller reports as "no samples found".
 */
export function parseJsonArray(raw: string): ExtractedSample[] {
  const fenced = raw.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  const start = fenced.indexOf('[');
  const end = fenced.lastIndexOf(']');
  if (start === -1 || end === -1) return [];
  try {
    const parsed = JSON.parse(fenced.slice(start, end + 1));
    return Array.isArray(parsed) ? (parsed as ExtractedSample[]) : [];
  } catch {
    return [];
  }
}

/** {@link prepareExtractedSamples} output: what to create, and what was fixed. */
export interface PreparedSamples {
  samples: Array<{
    type: string;
    id?: string;
    alias?: string;
    description?: string;
    location?: string;
    /** The name as the note wrote it, when the alias rules changed it (#390). Not passed to the tool. */
    originalAlias?: string;
  }>;
  /** Samples whose model-given id broke the `<Type>-<number>` rule and gets a new one. */
  regenerated: number;
  /** Samples dropped because their type is not a known sample type. */
  unknownType: number;
}

/**
 * Bring model-extracted samples in line with the sample rules before saving
 * (#61): the type takes its known spelling (unknown types are dropped), an id
 * keeps its canonical form when it is `<Type>-<number>` and is otherwise
 * replaced by a generated one. A dropped id like `ND-11` is usually a model
 * or catalog number, so it is kept as the alias when the model gave none.
 */
export function prepareExtractedSamples(
  extracted: readonly ExtractedSample[],
  types: readonly string[]
): PreparedSamples {
  const out: PreparedSamples = { samples: [], regenerated: 0, unknownType: 0 };
  for (const s of extracted) {
    const type = typeof s.type === 'string' ? canonicalSampleType(s.type, types) : undefined;
    if (!type) {
      out.unknownType++;
      continue;
    }
    const rawId = typeof s.id === 'string' && s.id.trim() ? s.id.trim() : undefined;
    const id = rawId === undefined ? undefined : normalizeSampleId(type, rawId);
    const rawAlias = typeof s.alias === 'string' && s.alias.trim() ? s.alias.trim() : undefined;
    const alias = rawAlias === undefined ? undefined : toAlias(rawAlias);
    const description = typeof s.description === 'string' ? s.description.replace(/;/g, ',') : undefined;
    // Free text in the registry, so it goes in as written (#190).
    const location = typeof s.location === 'string' && s.location.trim() ? s.location.trim() : undefined;
    const renamed = (from: string | undefined, to: string | undefined) =>
      from !== undefined && to !== undefined && from !== to ? { originalAlias: from } : {};
    if (rawId !== undefined && !id) {
      out.regenerated++;
      const fromId = alias === undefined;
      const kept = alias ?? toAlias(rawId);
      out.samples.push({ type, alias: kept, description, location, ...renamed(fromId ? rawId : rawAlias, kept) });
    } else {
      out.samples.push({ type, id, alias, description, location, ...renamed(rawAlias, alias) });
    }
  }
  return out;
}

/** A description compared the way {@link skipKnownSamples} compares them. */
function descriptionKey(v: string): string {
  return v.replace(/;/g, ',').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Split extracted samples into new ones and ones already there (#153): an id
 * a registry in `registries` (`type → id → record`) holds or the note already
 * references (`referenced`, `type|id`), or the alias of a sample of the same
 * type (case ignored, registry aliases fitted like extracted ones). With no
 * alias on either side, the same type and description also count as the same
 * sample. Running the command again then adds only what is new.
 */
export function skipKnownSamples(
  samples: PreparedSamples['samples'],
  registries: ReadonlyArray<Record<string, Record<string, SampleRecord>>>,
  referenced: ReadonlySet<string>
): { fresh: PreparedSamples['samples']; skipped: number } {
  const ids = new Set(referenced);
  const aliases = new Set<string>();
  const descriptions = new Set<string>();
  const aliasKey = (type: string, alias: string | null | undefined): string | undefined => {
    const fitted = alias?.trim() ? toAlias(alias) : undefined;
    return fitted === undefined ? undefined : `${type}|${fitted}`.toLowerCase();
  };
  const descKey = (type: string, description: string | undefined): string | undefined => {
    const key = description ? descriptionKey(description) : '';
    return key ? `${type.toLowerCase()}|${key}` : undefined;
  };
  for (const registry of registries) {
    for (const [type, records] of Object.entries(registry)) {
      for (const [id, rec] of Object.entries(records)) {
        ids.add(`${type}|${id}`.toLowerCase());
        const a = aliasKey(type, rec.alias);
        if (a) aliases.add(a);
        else {
          for (const d of rec.descriptions ?? []) {
            const k = descKey(type, d);
            if (k) descriptions.add(k);
          }
        }
      }
    }
  }
  const fresh: PreparedSamples['samples'] = [];
  let skipped = 0;
  for (const s of samples) {
    const a = aliasKey(s.type, s.alias);
    const d = a ? undefined : descKey(s.type, s.description);
    const known =
      (s.id !== undefined && ids.has(`${s.type}|${s.id}`.toLowerCase())) ||
      (a !== undefined && aliases.has(a)) ||
      (d !== undefined && descriptions.has(d));
    if (known) {
      skipped++;
      continue;
    }
    fresh.push(s);
    // Two extracted entries for one sample count once.
    if (s.id !== undefined) ids.add(`${s.type}|${s.id}`.toLowerCase());
    if (a) aliases.add(a);
    if (d) descriptions.add(d);
  }
  return { fresh, skipped };
}

/** Ask the model to extract sample definitions, then persist them via the tool. */
export async function extractSamplesCommand(env: AiEnv): Promise<void> {
  const target = env.ctx.host.editTarget();
  if (!target) {
    env.host.notify('info', env.host.t('Open a note first.'));
    return;
  }
  // Read from the same target we persist samples against (see above).
  const text = await target.getText();
  if (!text.trim()) {
    env.host.notify('info', env.host.t('Nothing to extract.'));
    return;
  }

  // Taken before the network wait: the relative registry paths below must still name this vault when written (D11).
  const guard = await vaultGuard(env.invoke);
  const samples = env.sampleEnv();
  const types = samples.types();
  const out = await complete(env, [
    {
      role: 'system',
      content:
        'Extract laboratory sample definitions from the text. Respond with ONLY a JSON array of objects with keys "type", "id" (optional), "alias" (optional), "description" (optional), "location" (optional). ' +
        `"type" must be one of: ${types.join(', ')}. ` +
        '"alias" is the short name or code the text gives the sample (e.g. "YE-22"). ' +
        '"location" is where the text says it is stored (e.g. "4°C fridge shelf 1"); keep it out of "description". ' +
        'Copy "alias", "description" and "location" in the language and wording the text uses; never translate them. ' +
        '"id" must look like "<type>-<number>" (e.g. "DNA-3"); omit it when the text gives no such id — do not use model or catalog numbers as ids. No prose.',
    },
    { role: 'user', content: text.slice(0, 6000) },
  ]);
  if (!out) return;

  const prepared = prepareExtractedSamples(parseJsonArray(out.content).filter(s => s.type), types);
  if (prepared.samples.length === 0) {
    env.host.notify('info', env.host.t('No samples found.'));
    return;
  }

  const globalFolder = samples.globalFolder();
  const folders = [noteLabsamplesFolder(target.path, globalFolder), globalFolder].filter(Boolean);
  const sampleTypes = [...new Set(prepared.samples.map(s => s.type))];
  const registries: Array<Record<string, Record<string, SampleRecord>>> = [];
  for (const folder of folders) {
    const registry: Record<string, Record<string, SampleRecord>> = {};
    for (const type of sampleTypes) registry[type] = await loadSamplesByType(samples.fs, folder, type);
    registries.push(registry);
  }
  const referenced = new Set(
    findSampleReferenceSpans(await target.getText(), types).map(r => `${r.type}|${r.id}`.toLowerCase())
  );
  const { fresh, skipped } = skipKnownSamples(prepared.samples, registries, referenced);

  const tools = createLabnoteTools();
  // Set once a guard check failed: the open vault was switched, so nothing more is written.
  let switched = false;
  const check = async (): Promise<void> => {
    try {
      await guard.check();
    } catch (err) {
      switched = true;
      throw err;
    }
  };
  const stopped = (): boolean => switched || guard.signal.aborted;
  const base = toolContext(env, { beforeWrite: check });
  // Registries the guard refused to write (a conflict left in them): reported once each after the run.
  const unreadable = new Set<string>();
  const remember = <T>(p: Promise<T>): Promise<T> =>
    p.catch((err: unknown) => {
      if (err instanceof RegistryUnreadableError) unreadable.add(err.path);
      throw err;
    });
  const ctx = {
    ...base,
    fs: {
      ...base.fs,
      write: async (p: string, c: string) => {
        await check();
        return remember(base.fs.write(p, c));
      },
      modify: async (p: string, u: (s: string) => string) => {
        await check();
        return remember(base.fs.modify(p, u));
      },
      mkdir: async (p: string) => {
        await check();
        return base.fs.mkdir(p);
      },
      remove: async (p: string) => {
        await check();
        return base.fs.remove(p);
      },
      rmdir: async (p: string) => {
        await check();
        return base.fs.rmdir(p);
      },
    },
  };

  let created = 0;
  let noLocation = 0;
  let inGlobal = false;
  const renamed: string[] = [];
  const written = new Set<string>();
  try {
    for (const { originalAlias, ...s } of fresh) {
      // The open vault was switched: nothing more is written, and the notices would name the wrong vault.
      if (stopped()) return;
      const res = await runTool(tools, 'create_sample', ctx, { ...s, documentPath: target.path });
      if (stopped()) return;
      if (res.ok) {
        created++;
        if (!s.location) noLocation++;
        const data = res.data as { scope?: string; folder?: string; type?: string } | undefined;
        if (data?.scope === 'global') inGlobal = true;
        if (data?.folder) written.add(`${data.folder}/${data.type ?? s.type}.json`);
        if (originalAlias !== undefined) renamed.push(`${originalAlias} → ${s.alias}`);
      }
    }
  } finally {
    // After a switch these relative paths would be re-read in the new vault.
    if (written.size > 0 && !stopped()) samples.changed([...written]);
  }
  const parts = [
    skipped > 0
      ? env.host.t('Created {0} new sample(s); skipped {1} already registered or in the note.', String(created), String(skipped))
      : env.host.t('Created {0} sample(s).', String(created)),
  ];
  if (prepared.regenerated > 0) {
    parts.push(env.host.t('{0} got a new ID because theirs did not match <Type>-<number>.', String(prepared.regenerated)));
  }
  if (prepared.unknownType > 0) {
    parts.push(env.host.t('{0} skipped: unknown sample type.', String(prepared.unknownType)));
  }
  if (noLocation > 0) {
    parts.push(env.host.t('{0} have no storage location; add it with Edit sample in the Samples view.', String(noLocation)));
  }
  if (inGlobal) {
    parts.push(env.host.t('This note is outside an experiment folder, so they were added to Global samples.'));
  }
  if (renamed.length > 0) {
    // The note keeps the name as written; say what it is registered as (#390).
    const shown = renamed.slice(0, 5).join(', ');
    parts.push(
      env.host.t(
        'Aliases changed to fit the alias rules (_ : ; # * become - or go): {0}',
        renamed.length > 5 ? env.host.t('{0} (+{1} more)', shown, String(renamed.length - 5)) : shown
      )
    );
  }
  env.host.notify(renamed.length > 0 ? 'warn' : 'info', parts.join(' '));
  for (const path of unreadable) env.host.notify('warn', appT('samples.registryUnreadable', path));
}
