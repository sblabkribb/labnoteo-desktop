// Ported from app/vendor/labnoteo/src/sampleDiscovery.ts:1-48 sha256:c1bd767f35edbcc8
// labnoteO 0.142.0, Apache-2.0.
// Changes: new in 0.142.0. LabnotePlugin → SampleEnv (D5); plugin.settings.customSampleTypes → env.settings().customSampleTypes; plugin.settings.globalSampleFolder → env.globalFolder() (normalised); plugin.fs → env.fs (safeRegistryFs over the recycle bin: discovery only lists and reads); plugin.host.notify / plugin.host.pickMany → env.host.notify / env.host.pickMany; plugin.t → env.t; the settings write (plugin.settings.customSampleTypes = …; saveSettings; refreshSampleViews) → env.updateSettings({ customSampleTypes }) and env.changed(). The app asks once per vault when samples are tracked (App.tsx → commands/sampleDiscovery.ts), as the plugin does on layout ready.
import { getSampleDisplayMeta } from '@labnoteo/core/lib/sampleUtils';
import { listExperimentSampleFolders } from '@labnoteo/core/lib/sampleStorage';
import type { SampleEnv } from '../../samples/env';
import { partitionCustomSampleTypes } from './customSampleTypes';

/** Inspect only configured registries. Discovery never migrates or rewrites a ledger. */
export async function discoverSampleTypes(env: SampleEnv): Promise<void> {
  const known = getSampleDisplayMeta(env.settings().customSampleTypes).types;
  const folders = [...new Set([env.globalFolder(), ...(await listExperimentSampleFolders(env.fs, ''))].filter(Boolean))];
  const candidates = new Map<string, { paths: string[]; count: number }>();
  const problems: string[] = [];
  for (const folder of folders) {
    for (const name of await env.fs.list(folder)) {
      if (!name.endsWith('.json')) continue;
      const type = name.slice(0, -5);
      if (known.includes(type)) continue;
      const file = `${folder}/${name}`;
      try {
        const raw: unknown = JSON.parse(await env.fs.read(file));
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { problems.push(file); continue; }
        const rows = Object.values(raw);
        if (!rows.length) continue;
        // A catalog has a filename suffix, but records belong to its base type.
        const catalog = known.some(k => type.startsWith(`${k}_`) && Object.entries(raw).every(([id, r]) => r && typeof r === 'object' && ((r as { type?: unknown }).type === k || ((r as { type?: unknown }).type === undefined && id.startsWith(`${k}-`)))));
        if (catalog) continue;
        const valid = rows.every(r => r && typeof r === 'object' && !Array.isArray(r) && ((r as { type?: unknown }).type === undefined || (r as { type?: unknown }).type === type));
        const checked = partitionCustomSampleTypes([...env.settings().customSampleTypes, type].join(','), env.settings().customSampleTypes);
        if (!valid || !checked.save.includes(type)) { problems.push(file); continue; }
        const entry = candidates.get(type) ?? { paths: [], count: 0 };
        entry.paths.push(file); entry.count += rows.length; candidates.set(type, entry);
      } catch { problems.push(file); }
    }
  }
  for (const [type, info] of [...candidates]) {
    if ([...candidates.keys()].some(other => other !== type && other.toLowerCase() === type.toLowerCase())) {
      problems.push(...info.paths);
    }
  }
  for (const [type, info] of candidates) if (info.paths.some(file => problems.includes(file))) candidates.delete(type);
  if (problems.length) env.host.notify('warn', env.t('Sample registries need attention (invalid JSON, type mismatch or conflicting type name): {0}', problems.join(', ')));
  if (!candidates.size) return;
  const choices = [...candidates].map(([value, info]) => ({ value, label: value, description: `${info.count}: ${info.paths.join(', ')}` }));
  const types = await env.host.pickMany(choices, { title: env.t('Register sample types found in this vault') });
  if (!types.length) return;
  const settings = env.settings();
  await env.updateSettings({
    customSampleTypes: partitionCustomSampleTypes([...settings.customSampleTypes, ...types].join(','), settings.customSampleTypes).save,
  });
  env.changed();
}
