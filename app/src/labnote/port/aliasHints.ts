// Ported from app/vendor/labnoteo/src/commands.ts:331-438 sha256:6d160ba5da070d7b
// Ported from app/vendor/labnoteo/src/commands.ts:1300-1319 sha256:b38bc58dad3f9b74
// labnoteO 0.138.0, Apache-2.0.
// Changes: catalogDescription(id, description) -> catalogDescription(id, description, locale); `getObsidianLanguage()` -> the `locale` parameter.
// Changes: catalogKoFields is exported and takes a `locale` parameter instead of reading `getObsidianLanguage()`.
// Changes: readChecklistLabels takes `LabnoteFs`; README is imported from ../paths; the imports below replace the top of commands.ts.

import type { LabnoteFs, LabnoteHost, PromptHint, UnitOpBlock } from '@labnoteo/core';
import { catalogDescriptionFor, catalogKoEntry, findSameAliasUnitOp } from '@labnoteo/core';
import * as posix from '@labnoteo/core/posix';
import {
  findSameAliasWorkflow,
  workflowAliasBudget,
  workflowAliasLength,
  workflowAliasProblem,
  workflowChecklistLabels,
} from '@labnoteo/core/lib/workflowStructure';
import { README } from '../paths';

/**
 * The alias modal's check (#411): a `#` breaks links to the heading, and a
 * `*` or `_` turns part of it italic (#421). `keep` is an alias already in
 * use (a copy's original), passed through unchanged.
 */
export function workflowAliasValidator(
  host: Pick<LabnoteHost, 't'>,
  keep?: string
): (value: string) => string | null {
  return value => {
    if (value.trim() === (keep ?? '').trim()) return null;
    const problem = workflowAliasProblem(value);
    if (problem === 'hash') return host.t('An alias cannot contain "#": links to its heading would break.');
    if (problem === 'markdown') {
      return host.t(
        'An alias cannot contain "*", or "_" next to anything but ASCII letters and digits: the reading view shows part of it in italics. Use a space; the file name gets "_" for it anyway.'
      );
    }
    return null;
  };
}

/** The README checklist label of each workflow in experiment folder `labnoteDir`; empty without a README. */
export async function readChecklistLabels(fs: LabnoteFs, labnoteDir: string): Promise<Map<string, string>> {
  const readmePath = posix.join(labnoteDir, README);
  return (await fs.exists(readmePath)) ? workflowChecklistLabels(await fs.read(readmePath)) : new Map();
}

/**
 * How much of a workflow alias fits in the file name after `ID_name_` (#213);
 * the room differs per workflow. Never blocks: past it only the file name is cut.
 */
export function workflowAliasHint(
  host: Pick<LabnoteHost, 't'>,
  id: string,
  name: string,
  /** The experiment folder's file names: an alias another workflow of this ID has is flagged (#297). */
  existing: readonly string[] = [],
  /** The README checklist labels of `existing` (see {@link readChecklistLabels}). */
  labels?: ReadonlyMap<string, string>
): (value: string) => PromptHint {
  const budget = workflowAliasBudget(id, name);
  return value => {
    const twin = findSameAliasWorkflow(existing, id, name, value, labels);
    if (twin) {
      return {
        text: host.t(
          '{0} already has this ID and alias, so the two would read the same in the README checklist. Give this one its own alias to tell them apart.',
          twin
        ),
        warn: true,
      };
    }
    const length = workflowAliasLength(value);
    if (budget === 0) {
      return {
        text: host.t(
          "This workflow's name is long, so the alias won't fit in the file name. The title and checklist still keep it."
        ),
        warn: length > 0,
      };
    }
    return {
      text: host.t(
        '{0}/{1} characters in the file name. Anything longer is cut from the file name only; the workflow title and checklist keep it all.',
        String(length),
        String(budget)
      ),
      warn: length > budget,
    };
  };
}

/** A unit-operation alias goes into no file name, so it has no limit (#213). */
export function unitOpAliasHint(
  host: Pick<LabnoteHost, 't'>,
  op: { id: string; name: string } = { id: '', name: '' },
  /** The note's unit operations: one of this ID with the same alias is flagged (#339). */
  blocks: readonly UnitOpBlock[] = []
): (value: string) => PromptHint {
  return value => {
    const twin = findSameAliasUnitOp(blocks, op.id, op.name, value);
    if (twin) {
      return {
        text: host.t(
          '{0} is already in this note, so the two would read the same in the headings and the table of contents. Give this one its own alias to tell them apart.',
          `[${twin.opId} ${twin.opName}]${twin.alias ? ` ${twin.alias}` : ''}`
        ),
        warn: true,
      };
    }
    return {
      text: host.t('{0} characters · no limit (not used in a file name)', String(Array.from(value.trim()).length)),
    };
  };
}

/** What a workflow is, for the workflow name prompts (#213). */
export function workflowConcept(host: Pick<LabnoteHost, 't'>): string {
  return host.t(
    'A workflow is a note for one design, build, test or learn stage of the experiment. The alias tells uses of the same workflow apart and also goes into the file name and the README checklist. You can leave it empty.'
  );
}

/** A catalog item's description in the UI language, when the vault's copy still has the bundled text (#213). */
export function catalogDescription(id: string, description: string, locale: string): string {
  return catalogDescriptionFor(id, description, locale);
}

/**
 * A catalog item's picker lines: in the Korean UI its Korean name before the
 * category, with its search words (#163), and its description translated
 * (#213). The English description then stays searchable as a keyword.
 * Nothing Korean for items a lab added or descriptions a lab edited.
 */
export function catalogKoFields(
  id: string,
  category: string,
  description: string,
  locale: string
): { description: string; detail: string; keywords?: readonly string[] } {
  const ko = locale.toLowerCase().startsWith('ko') ? catalogKoEntry(id) : undefined;
  const detail = catalogDescription(id, description, locale);
  const keywords = [...(ko ? [ko.name, ...(ko.keywords ?? [])] : []), ...(detail !== description ? [description] : [])];
  return {
    description: ko ? `${ko.name} · ${category}` : category,
    detail,
    ...(keywords.length > 0 ? { keywords } : {}),
  };
}
