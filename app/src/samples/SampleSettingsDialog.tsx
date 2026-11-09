import { useEffect, useId, useRef, useState } from 'react';
import { isSameSampleFolder } from '@labnoteo/core/lib/sampleStorage';
import { suggestSampleTypeName } from '@labnoteo/core/lib/sampleUtils';
import { t } from '../i18n/t';
import { coreT } from '../labnote/i18n';
import type { CommandContext } from '../labnote/commands/context';
import { DialogFrame } from '../labnote/host/DialogFrame';
import { openDialog, type DialogSpec } from '../labnote/host/dialogStore';
import { partitionCustomSampleTypes, removedCustomSampleTypes } from '../labnote/port/customSampleTypes';
import { commitGlobalFolder, offerGlobalSampleFolderMove, offerToRestoreSampleTypes } from '../labnote/port/sampleSettings';
import type { AppSettings } from '../labnote/settings';
import { createSampleEnv, normalizeSampleFolder, type SampleEnv } from './env';
import { samples } from './sampleStore';
import { sampleTypesFor } from './types';

/** 플러그인 samplesSection 의 세 설정(D17). */
export interface SampleSettingsValue {
  sampleTracking: boolean;
  customSampleTypes: string[];
  globalSampleFolder: string;
}

/** 샘플 설정 대화상자를 연다. 저장하면 새 값, 닫으면 undefined. 대화상자는 값만 돌려주고 적용은 applySampleSettings 가 한다(D16). */
export function openSampleSettings(current: SampleSettingsValue): Promise<SampleSettingsValue | undefined> {
  return openDialog<SampleSettingsValue | undefined>({ kind: 'sampleSettings', value: current }, undefined);
}

const pickSampleSettings = (s: AppSettings): SampleSettingsValue => ({
  sampleTracking: s.sampleTracking,
  customSampleTypes: s.customSampleTypes,
  globalSampleFolder: s.globalSampleFolder,
});

/**
 * 대화상자가 돌려준 값을 적용한다: 바뀐 설정만 `ctx.updateSettings` 로 저장하고 곧바로 `samples.configure` 로 샘플 저장소를
 * 다시 묶는다(추적 스위치는 다시 불러오지 않아도 바로 적용된다, D11). 그다음 플러그인이 설정 창을 닫을 때 묻는 것을 같은
 * 순서로 묻는다: Global 폴더가 바뀌었으면 옛 폴더의 샘플을 옮길지(#101), 지운 사용자 종류에 샘플이 있으면 되돌릴지(#137).
 * 묻는 동안 쓰는 SampleEnv 는 새 설정을 본다(앱의 ctx.settings 는 다시 그려진 뒤에야 바뀐다).
 */
export async function applySampleSettings(env: SampleEnv, ctx: CommandContext, before: SampleSettingsValue, after: SampleSettingsValue): Promise<void> {
  const patch: Partial<AppSettings> = {};
  if (after.sampleTracking !== before.sampleTracking) patch.sampleTracking = after.sampleTracking;
  if (after.customSampleTypes.join('\n') !== before.customSampleTypes.join('\n')) patch.customSampleTypes = [...after.customSampleTypes];
  if (after.globalSampleFolder !== before.globalSampleFolder) patch.globalSampleFolder = after.globalSampleFolder;
  if (Object.keys(patch).length === 0) return;

  let current: AppSettings = { ...ctx.settings, ...patch };
  const save = (p: Partial<AppSettings>) => {
    current = { ...current, ...p };
    ctx.updateSettings(p);
    samples.configure(ctx.host.fs, pickSampleSettings(current));
  };
  save(patch);

  const live: SampleEnv = {
    ...env,
    settings: () => current,
    types: () => sampleTypesFor(current),
    globalFolder: () => normalizeSampleFolder(current.globalSampleFolder),
  };
  const from = normalizeSampleFolder(before.globalSampleFolder);
  const to = normalizeSampleFolder(after.globalSampleFolder);
  if (!isSameSampleFolder(from, to)) await offerGlobalSampleFolderMove(live, from, to);
  const removed = removedCustomSampleTypes(before.customSampleTypes, after.customSampleTypes);
  if (removed.length > 0) await offerToRestoreSampleTypes(live, removed, (customSampleTypes) => save({ customSampleTypes }));
}

/** `app.sample-settings` 명령: 지금 설정으로 대화상자를 열고, 저장하면 적용한다. */
export async function runSampleSettings(ctx: CommandContext): Promise<void> {
  const before = pickSampleSettings(ctx.settings);
  const after = await openSampleSettings(before);
  if (after) await applySampleSettings(createSampleEnv(ctx), ctx, before, after);
}

/** renderCustomTypes 의 blur 문장들(settingsTab.ts:233-530): 저장하지 않은 이름마다 그 까닭. */
function typeNotices(input: string, stored: readonly string[]): string[] {
  const { rejected, italic, caseDuplicates, caseRenamed } = partitionCustomSampleTypes(input, stored);
  const out: string[] = [];
  if (rejected.length > 0) {
    out.push(
      coreT(
        '{0}: a space or - keeps a type from autocompleting, so it was not saved. Use {1} instead.',
        rejected.map((r) => r.name).join(', '),
        rejected.map((r) => r.suggestion).join(', '),
      ),
    );
  }
  if (italic.length > 0) {
    out.push(
      coreT(
        '{0}: a _ next to a letter that is not A–Z or a digit shows the name in italics in the reading view, so it was not saved. Use {1} instead.',
        italic.map((r) => r.name).join(', '),
        italic.map((r) => r.suggestion).join(', '),
      ),
    );
  }
  if (caseDuplicates.length > 0) {
    out.push(
      coreT(
        '{0}: differs from {1} only in letter case, so on Windows both would share one {Type}.json and their samples would mix. It was not saved.',
        caseDuplicates.map((d) => d.name).join(', '),
        caseDuplicates.map((d) => d.clashesWith).join(', '),
      ),
    );
  }
  if (caseRenamed.length > 0) {
    out.push(
      coreT(
        '{0}: only the letter case of {1} changed. Its samples and the IDs already written in notes keep {1}, so the change was not saved.',
        caseRenamed.map((d) => d.name).join(', '),
        caseRenamed.map((d) => d.stored).join(', '),
      ),
    );
  }
  return out;
}

/** renderCustomTypes 가 설명 밑에 다는 경고(예전 판이 저장한 이름). */
function legacyWarnings(stored: readonly string[]): string[] {
  const { legacyInvalid, legacyItalic, legacyCaseDuplicates } = partitionCustomSampleTypes(stored.join(','), stored);
  const out: string[] = [];
  if (legacyInvalid.length > 0) {
    out.push(
      coreT(
        '{0} cannot be autocompleted in notes (a space or -). Rename it, e.g. {1}, if you have no samples of it yet.',
        legacyInvalid.join(', '),
        legacyInvalid.map(suggestSampleTypeName).join(', '),
      ),
    );
  }
  if (legacyItalic.length > 0) {
    out.push(
      coreT(
        '{0} is shown in italics in the reading view because of its _. It keeps working; rename it, e.g. {1}, if you have no samples of it yet.',
        legacyItalic.join(', '),
        legacyItalic.map(suggestSampleTypeName).join(', '),
      ),
    );
  }
  if (legacyCaseDuplicates.length > 0) {
    out.push(
      coreT(
        '{0} differs from {1} only in letter case: on Windows both share one {Type}.json, so their samples mix. Keep one of them.',
        legacyCaseDuplicates.map((d) => d.name).join(', '),
        legacyCaseDuplicates.map((d) => d.clashesWith).join(', '),
      ),
    );
  }
  return out;
}

/**
 * 샘플 설정 대화상자(plan SP5 Task 28, D17). 플러그인 samplesSection 의 세 줄을 그 이름과 설명(coreT)으로 보인다. 추적 스위치의
 * 설명만 앱 키다(앱에서는 바로 적용된다). 사용자 종류 칸은 칸을 떠날 때 저장하지 않을 이름의 까닭을 보이고 칸을 저장할 값으로
 * 되돌린다. Global 폴더 칸은 칸을 떠날 때 commitGlobalFolder 로 검사한다. 순수한 화면이다: 저장하면 값을 돌려줄 뿐이다.
 */
export function SampleSettingsDialog(props: {
  spec: Extract<DialogSpec, { kind: 'sampleSettings' }>;
  onDone: (value: SampleSettingsValue) => void;
  onCancel: () => void;
}) {
  const { value } = props.spec;
  const id = useId();
  // 검사가 생기기 전에 저장된 이름은 계속 쓸 수 있다(#81).
  const stored = useRef(value.customSampleTypes).current;
  const [tracking, setTracking] = useState(value.sampleTracking);
  const [types, setTypes] = useState(value.customSampleTypes.join(', '));
  const [notices, setNotices] = useState<string[]>([]);
  const [folder, setFolder] = useState(value.globalSampleFolder);
  const [committed, setCommitted] = useState(value.globalSampleFolder);
  const [folderNotice, setFolderNotice] = useState<string | undefined>(undefined);
  const first = useRef<HTMLInputElement>(null);
  const legacy = useRef(legacyWarnings(stored)).current;

  useEffect(() => first.current?.focus(), []);

  const leaveTypes = () => {
    const next = typeNotices(types, stored);
    setNotices(next);
    if (next.length > 0) setTypes(partitionCustomSampleTypes(types, stored).save.join(', '));
  };

  /** 칸의 폴더를 검사한다. 거절되면 까닭을 보이고 칸을 앞 값으로 되돌린다. 남길 폴더를 돌려준다(거절이면 undefined). */
  const leaveFolder = (): string | undefined => {
    const r = commitGlobalFolder(coreT, folder, committed);
    setFolder(r.value);
    setCommitted(r.value);
    setFolderNotice(r.notice);
    return r.notice ? undefined : r.value;
  };

  const save = () => {
    const kept = leaveFolder();
    if (kept === undefined) return;
    props.onDone({ sampleTracking: tracking, customSampleTypes: partitionCustomSampleTypes(types, stored).save, globalSampleFolder: kept });
  };

  return (
    <DialogFrame title={t('cmd.sampleSettings')} className="prompt sample-settings" onCancel={props.onCancel}>
      <div className="sample-settings-row">
        <label className="prompt-question">
          <input ref={first} id={`${id}-tracking`} type="checkbox" checked={tracking} onChange={(e) => setTracking(e.target.checked)} />{' '}
          {coreT('Sample tracking')}
        </label>
        <p className="prompt-hint">{t('samples.settings.trackingLive')}</p>
      </div>
      <div className="sample-settings-row">
        <label className="prompt-question" htmlFor={`${id}-types`}>
          {coreT('Custom sample types')}
        </label>
        <p className="prompt-hint">
          {coreT(
            'Comma-separated types in addition to the built-ins. Use letters, digits and _ only (no spaces or -), e.g. CellLine, 배지. A _ works between ASCII letters and digits (Cell_Line); next to other letters it turns the name italic in the reading view, so write those together (무세포용해물).',
          )}
        </p>
        {legacy.map((w, i) => (
          <p key={`legacy-${i}`} className="prompt-hint warn">
            {w}
          </p>
        ))}
        <input
          id={`${id}-types`}
          type="text"
          placeholder="CellLine, Strain"
          value={types}
          onChange={(e) => {
            setTypes(e.target.value);
            setNotices([]);
          }}
          onBlur={leaveTypes}
        />
        {notices.map((n, i) => (
          <p key={`notice-${i}`} role="alert" className="prompt-hint warn">
            {n}
          </p>
        ))}
      </div>
      <div className="sample-settings-row">
        <label className="prompt-question" htmlFor={`${id}-folder`}>
          {coreT('Global sample folder')}
        </label>
        <p className="prompt-hint">{coreT('Vault-relative folder for vault-global samples.')}</p>
        <input
          id={`${id}-folder`}
          type="text"
          value={folder}
          onChange={(e) => {
            setFolder(e.target.value);
            setFolderNotice(undefined);
          }}
          onBlur={() => void leaveFolder()}
        />
        {folderNotice ? (
          <p role="alert" className="prompt-hint warn">
            {folderNotice}
          </p>
        ) : null}
      </div>
      <div className="dialog-actions">
        <button type="button" className="primary" onClick={save}>
          {t('samples.settings.save')}
        </button>
        <button type="button" onClick={props.onCancel}>
          {coreT('Cancel')}
        </button>
      </div>
    </DialogFrame>
  );
}
