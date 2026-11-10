import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { isSameSampleFolder } from '@labnoteo/core/lib/sampleStorage';
import { getSampleDisplayMeta, suggestSampleTypeName } from '@labnoteo/core/lib/sampleUtils';
import { t } from '../i18n/t';
import { coreT } from '../labnote/i18n';
import type { CommandContext } from '../labnote/commands/context';
import { partitionCustomSampleTypes, removedCustomSampleTypes } from '../labnote/port/customSampleTypes';
import { commitGlobalFolder, offerGlobalSampleFolderMove, offerToRestoreSampleTypes } from '../labnote/port/sampleSettings';
import type { AppSettings } from '../labnote/settings';
import { SettingRow, Toggle } from '../ui/settings/SettingRow';
import { normalizeSampleFolder, type SampleEnv } from './env';
import { samples } from './sampleStore';
import { sampleTypesFor } from './types';

/** 플러그인 samplesSection 의 세 설정(D17). */
export interface SampleSettingsValue {
  sampleTracking: boolean;
  customSampleTypes: string[];
  globalSampleFolder: string;
}

/** 지금 설정의 샘플 세 값. 설정 창의 "샘플" 쪽이 이 값으로 열린다. */
export const pickSampleSettings = (s: AppSettings): SampleSettingsValue => ({
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
  if (!isSameSampleFolder(from, to)) {
    // 함께 지운 사용자 종류의 샘플도 옛 폴더에 남지 않게 옮긴다: 그래야 뒤이은 되돌리기 제안이 새 폴더에서 그것들을 센다.
    const union = [...after.customSampleTypes, ...before.customSampleTypes.filter((ty) => !after.customSampleTypes.includes(ty))];
    const moveTypes = getSampleDisplayMeta(union).types;
    await offerGlobalSampleFolderMove({ ...live, types: () => moveTypes }, from, to);
  }
  const removed = removedCustomSampleTypes(before.customSampleTypes, after.customSampleTypes);
  if (removed.length > 0) await offerToRestoreSampleTypes(live, removed, (customSampleTypes) => save({ customSampleTypes }));
}

/**
 * 저장하면 applySampleSettings 가 무언가를 물을 수 있는가: Global 폴더가 바뀌었거나(옮길지) 사용자 종류를 지웠다(되돌릴지).
 * 그러면 설정 창을 먼저 닫는다: 묻는 대화상자가 설정 창 뒤에 줄 서지 않게. 아니면 설정 창 안에서 바로 적용한다.
 */
export function sampleSettingsMayAsk(before: SampleSettingsValue, after: SampleSettingsValue): boolean {
  if (!isSameSampleFolder(normalizeSampleFolder(before.globalSampleFolder), normalizeSampleFolder(after.globalSampleFolder))) return true;
  return removedCustomSampleTypes(before.customSampleTypes, after.customSampleTypes).length > 0;
}

/** renderCustomTypes 의 blur 문장들(settingsTab.ts:233-530): 저장하지 않은 이름마다 그 까닭. */
function typeNotices(input: string, stored: readonly string[]): string[] {
  const { rejected, italic, caseDuplicates, caseRenamed, reserved } = partitionCustomSampleTypes(input, stored);
  const out: string[] = [];
  if (reserved.length > 0) {
    out.push(
      coreT(
        '{0}: Windows keeps this name for a device, so its {Type}.json cannot be made there. It was not saved. Use another name, such as {1}.',
        reserved.join(', '),
        reserved.map((r) => `${r}Sample`).join(', '),
      ),
    );
  }
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
  const { legacyInvalid, legacyItalic, legacyCaseDuplicates, legacyReserved } = partitionCustomSampleTypes(stored.join(','), stored);
  const out: string[] = [];
  if (legacyReserved.length > 0) {
    out.push(
      coreT(
        '{0} is a name Windows keeps for devices: its {Type}.json cannot be made or checked out on Windows, and git stops there. Move its samples to another type with Change type, then remove the name.',
        legacyReserved.join(', '),
      ),
    );
  }
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
 * 샘플 설정(plan SP5 Task 28, D17; UI 재설계 Task 8 부터 설정 창의 "샘플" 쪽). 플러그인 samplesSection 의 세 설정을 다른 설정
 * 쪽과 같은 줄(SettingRow: 왼쪽 이름·설명, 오른쪽 조작)로 보인다. 저장 단추는 없다: 추적 스위치는 누르면, 두 글 칸은 칸을 떠날 때
 * (또는 Enter) 바로 `onSave` 로 넘긴다. 사용자 종류 칸은 저장하지 않을 이름의 까닭을 보이고 칸을 저장할 값으로 되돌린다.
 * Global 폴더 칸은 commitGlobalFolder 로 검사하고, 거절되면 까닭을 보인 채 앞 값을 지킨다(넘기지 않는다).
 * 순수한 화면이다: 적용은 부른 쪽(applySampleSettings)이 한다(D16). 이름은 플러그인 키(coreT), 설명은 앱 키다.
 */
export function SampleSettingsForm(props: {
  value: SampleSettingsValue;
  onSave: (value: SampleSettingsValue) => void;
  /** 처음 조작(추적 스위치)에 초점을 줄지(설정 창은 왼쪽 목록에 초점을 두므로 주지 않는다). */
  autoFocus?: boolean;
}) {
  const { value } = props;
  const autoFocus = useRef(props.autoFocus === true);
  const id = useId();
  // 검사가 생기기 전에 저장된 이름은 계속 쓸 수 있다(#81).
  const stored = useRef(value.customSampleTypes).current;
  const [tracking, setTracking] = useState(value.sampleTracking);
  const [types, setTypes] = useState(value.customSampleTypes.join(', '));
  const [notices, setNotices] = useState<string[]>([]);
  const [folder, setFolder] = useState(value.globalSampleFolder);
  const [committed, setCommitted] = useState(value.globalSampleFolder);
  const [folderNotice, setFolderNotice] = useState<string | undefined>(undefined);
  const root = useRef<HTMLDivElement>(null);
  const legacy = useRef(legacyWarnings(stored)).current;
  /** 마지막으로 넘긴 값: 같은 값은 다시 넘기지 않는다. */
  const last = useRef<SampleSettingsValue>(value);

  useEffect(() => {
    if (autoFocus.current) root.current?.querySelector<HTMLElement>('[role="switch"]')?.focus();
  }, []);

  const commit = (patch: Partial<SampleSettingsValue>) => {
    const next: SampleSettingsValue = { ...last.current, ...patch };
    const same =
      next.sampleTracking === last.current.sampleTracking &&
      next.globalSampleFolder === last.current.globalSampleFolder &&
      next.customSampleTypes.join('\n') === last.current.customSampleTypes.join('\n');
    if (same) return;
    last.current = next;
    props.onSave(next);
  };

  /** 종류 칸을 떠난다: 저장하지 않을 이름의 까닭을 보이고 칸을 저장할 값으로 되돌린 뒤 그 값을 넘긴다. */
  const leaveTypes = () => {
    const next = typeNotices(types, stored);
    const kept = partitionCustomSampleTypes(types, stored).save;
    setNotices(next);
    if (next.length > 0) setTypes(kept.join(', '));
    commit({ customSampleTypes: kept });
  };

  /** 폴더 칸을 떠난다: 거절되면 까닭을 보이고 칸을 앞 값으로 되돌린다(그러면 넘길 것이 없다). */
  const leaveFolder = () => {
    const r = commitGlobalFolder(coreT, folder, committed);
    setFolder(r.value);
    setCommitted(r.value);
    if (r.notice) setFolderNotice(r.notice);
    commit({ globalSampleFolder: r.value });
  };

  const onEnter = (leave: () => void) => (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    leave();
  };

  return (
    <div className="sample-settings" ref={root}>
      <SettingRow
        label={coreT('Sample tracking')}
        description={t('samples.settings.trackingLive')}
        control={
          <Toggle
            label={coreT('Sample tracking')}
            checked={tracking}
            onChange={(next) => {
              setTracking(next);
              commit({ sampleTracking: next });
            }}
          />
        }
      />
      <SettingRow
        label={coreT('Custom sample types')}
        description={t('samples.settings.typesDesc')}
        control={
          <input
            id={`${id}-types`}
            type="text"
            className="setting-text"
            aria-label={coreT('Custom sample types')}
            autoComplete="off"
            spellCheck={false}
            placeholder="CellLine, Strain"
            value={types}
            onChange={(e) => {
              setTypes(e.target.value);
              setNotices([]);
            }}
            onBlur={leaveTypes}
            onKeyDown={onEnter(leaveTypes)}
          />
        }
      />
      {legacy.map((w, i) => (
        <p key={`legacy-${i}`} className="prompt-hint warn">
          {w}
        </p>
      ))}
      {notices.map((n, i) => (
        <p key={`notice-${i}`} role="alert" className="prompt-hint warn">
          {n}
        </p>
      ))}
      <SettingRow
        label={coreT('Global sample folder')}
        description={coreT('Vault-relative folder for vault-global samples.')}
        control={
          <input
            id={`${id}-folder`}
            type="text"
            className="setting-text"
            aria-label={coreT('Global sample folder')}
            autoComplete="off"
            spellCheck={false}
            value={folder}
            onChange={(e) => {
              setFolder(e.target.value);
              setFolderNotice(undefined);
            }}
            onBlur={leaveFolder}
            onKeyDown={onEnter(leaveFolder)}
          />
        }
      />
      {folderNotice ? (
        <p role="alert" className="prompt-hint warn">
          {folderNotice}
        </p>
      ) : null}
    </div>
  );
}
