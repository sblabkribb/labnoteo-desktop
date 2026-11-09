// Ported from app/vendor/labnoteo/src/sampleDefinitionModal.ts:28-29 sha256:a18941a1acc1cc83
// Ported from app/vendor/labnoteo/src/sampleDefinitionModal.ts:91-102 sha256:0f6a27425d2b7bf4
// Ported from app/vendor/labnoteo/src/sampleDefinitionModal.ts:104-265 sha256:6fcaff52416d91f2
// Ported from app/vendor/labnoteo/src/sampleDefinitionModal.ts:337-383 sha256:d4cd29fabdc9e9da
// labnoteO 0.138.0, Apache-2.0.
// Changes: the Modal becomes a pure model plus a React view (samples/SampleDefinitionDialog.tsx) that only returns the chosen action (D16); the flows run in the command (Task 24). plugin.t → env.t; plugin.settings.globalSampleFolder → env.globalFolder(). moveTarget is a function of env, the definition and {docPath, localFolder}. onOpen's rows become SampleDefinitionModel.rows, with renderDescriptions (one row per description, its defining notes as `sources`) and renderDefinedIn (the `sources` basenames as the value, not links) folded in; its buttons become the action list in vendor order. The partbank actions (Refresh storage location, Open in partbank) are dropped (SP6); the partbank row stays as display. "Open JSON file" opens the file in the app (env.openFile), so it is offered for a catalog too and does not depend on Platform.isDesktopApp. The title names the ID after 'Sample definition'. The catalog's read-only sentence is `notice`. renderUsages becomes groupUsages: the grouping, folder order and labels are the vendor's, and the view renders the <details> with the first OPEN_USAGE_GROUPS open; every spot is a link (the spots come from notes that exist), named by the path's basename without `.md` (Obsidian TFile.basename).
import type { Translator } from '@labnoteo/core';
import * as posix from '@labnoteo/core/posix';
import { getExperimentDir } from '@labnoteo/core/lib/labnoteStructure';
import { isSameSampleFolder, noteLocalSampleFolder, type SampleUsageSpot } from '@labnoteo/core/lib/sampleStorage';
import type { SampleEnv } from '../../samples/env';
import { coreT } from '../i18n';
import { sampleLocationText } from './sampleListTable';
import { usageSpotLabel, type ResolvedSampleDefinition } from './sampleQuery';

/** Experiment groups shown open in the usage list; the rest start folded. */
export const OPEN_USAGE_GROUPS = 5;

export type SampleDefinitionAction = 'edit' | 'delete' | 'discard' | 'undiscard' | 'moveGlobal' | 'moveLocal' | 'changeType' | 'openJson';

/** The plugin key of each button (rendered through coreT). The move button uses the moveTarget label instead. */
export const SAMPLE_ACTION_LABEL: Record<SampleDefinitionAction, string> = {
  edit: 'Edit sample',
  delete: 'Delete sample',
  discard: 'Mark as discarded',
  undiscard: 'Unmark discarded',
  moveGlobal: 'Move to Global',
  moveLocal: 'Move to Local',
  changeType: 'Change type',
  openJson: 'Open JSON file',
};

export interface SampleDefinitionModel {
  type: string;
  id: string;
  title: string;
  /** As onOpen builds them. `sources`: the notes (basenames) that put a description in. */
  rows: Array<{ label: string; value: string; sources?: string[] }>;
  /** A product catalog record. */
  readOnly: boolean;
  /** The catalog's read-only sentence. */
  notice?: string;
  /** Vendor order, partbank actions omitted. */
  actions: SampleDefinitionAction[];
  /** moveTarget's result. */
  move?: { toFolder: string; label: string };
}

export interface UsageGroup {
  /** The experiment folder's name; '' for the notes outside every experiment. */
  experiment: string;
  spots: Array<{ path: string; line: number; ch?: number; label: string }>;
}

export type SampleDefinitionResult = { action: SampleDefinitionAction } | { open: { path: string; line: number; ch?: number } } | undefined;

type ModelEnv = Pick<SampleEnv, 't' | 'globalFolder'>;
type Where = { docPath?: string; localFolder?: string };

/** The other scope's folder, or undefined when the note has no Local one. */
export function moveTarget(env: ModelEnv, def: ResolvedSampleDefinition, where: Where): { toFolder: string; label: string } | undefined {
  const { scope, folder } = def;
  const globalFolder = env.globalFolder();
  if (scope === 'local') {
    if (!globalFolder || isSameSampleFolder(folder, globalFolder)) return undefined;
    return { toFolder: globalFolder, label: env.t('Move to Global') };
  }
  const local = where.docPath ? noteLocalSampleFolder(where.docPath, globalFolder) : where.localFolder || undefined;
  if (!local || isSameSampleFolder(local, folder)) return undefined;
  return { toFolder: local, label: env.t('Move to Local') };
}

/** onOpen without the DOM: the rows, the read-only sentence and the buttons. */
export function definitionModel(env: ModelEnv, def: ResolvedSampleDefinition & { type: string; id: string }, where: Where): SampleDefinitionModel {
  const { scope, folder, record, type, id } = def;
  const jsonPath = def.file ?? posix.join(folder, `${type}.json`);
  const scopeLabel = scope === 'local' ? env.t('Local') : scope === 'global' ? env.t('Global') : env.t('Product catalog (read-only)');

  const source = record.source;
  const rows: SampleDefinitionModel['rows'] = [
    { label: env.t('Type'), value: type },
    { label: env.t('ID'), value: id },
    { label: env.t('Alias'), value: record.alias ?? '-' },
    { label: env.t('Location'), value: sampleLocationText(env, record) || '-' },
    // The partbank id is the one key that makes the link usable by hand.
    ...(source
      ? [
          {
            label: env.t('partbank'),
            value: [
              source.kid ?? source.id,
              env.t(source.type),
              source.connection === 'desktop' ? env.t('partbank desktop app') : env.t('partbank server'),
              source.origin,
            ].join(' · '),
          },
        ]
      : []),
    ...(record.discarded ? [{ label: env.t('Discarded'), value: record.discarded }] : []),
    { label: env.t('Scope'), value: scopeLabel },
    { label: env.t('File'), value: jsonPath },
  ];

  // renderDescriptions: every description, each with the notes whose `@type;` definition put it in (#172).
  const descriptions = record.descriptions ?? [];
  const bySource = record.descriptionSources ?? {};
  if (descriptions.length === 0) rows.push({ label: env.t('Description'), value: '-' });
  descriptions.forEach((value, i) => {
    const notes = Object.keys(bySource).filter((note) => bySource[note] === value);
    rows.push({
      label: descriptions.length > 1 ? env.t('Description {0}', String(i + 1)) : env.t('Description'),
      value,
      ...(notes.length > 0 ? { sources: notes } : {}),
    });
  });
  // renderDefinedIn: the notes the registry records as defining the sample.
  const sources = record.sources ?? [];
  if (sources.length > 0) rows.push({ label: env.t('Defined in'), value: sources.join(', ') });

  const isEditable = scope !== 'catalog';
  const actions: SampleDefinitionAction[] = [];
  const move = isEditable ? moveTarget(env, def, where) : undefined;
  if (isEditable) {
    actions.push('edit', 'delete', record.discarded ? 'undiscard' : 'discard');
    // #121: reachable from the keyboard through "Open sample definition".
    if (move) actions.push(scope === 'local' ? 'moveGlobal' : 'moveLocal');
    actions.push('changeType');
  }
  actions.push('openJson');

  return {
    type,
    id,
    title: `${env.t('Sample definition')} · ${id}`,
    rows,
    readOnly: !isEditable,
    ...(isEditable
      ? {}
      : {
          notice: env.t(
            'Samples in a product catalog file ({Type}_name.json) are read-only here. To change one, edit that file, or rename it back to {0} if it was the sample registry.',
            `${type}.json`,
          ),
        }),
    actions,
    ...(move ? { move } : {}),
  };
}

/** A note's name as Obsidian's TFile.basename gives it: the file name without `.md`. */
const noteName = (path: string) => posix.basename(path).replace(/\.md$/i, '');

/**
 * The lines that use the sample, grouped by experiment folder (#130, #291):
 * experiments in folder order, notes outside any experiment last.
 */
export function groupUsages(spots: readonly SampleUsageSpot[], translate: Translator = coreT): UsageGroup[] {
  const groups = new Map<string, SampleUsageSpot[]>();
  for (const spot of spots) {
    const key = getExperimentDir(spot.path) ?? '';
    groups.set(key, [...(groups.get(key) ?? []), spot]);
  }
  const keys = [...groups.keys()].sort((a, b) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)));
  return keys.map((key) => ({
    experiment: key ? posix.basename(key) : '',
    spots: groups.get(key)!.map((spot) => ({
      path: spot.path,
      line: spot.line,
      ch: spot.ch,
      label: `${noteName(spot.path)} · ${usageSpotLabel(translate, spot)}`,
    })),
  }));
}
