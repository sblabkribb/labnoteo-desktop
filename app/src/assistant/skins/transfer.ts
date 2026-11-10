/**
 * 스킨 파일 가져오기·내보내기 흐름(assistant 명세 §8.3, plan Task 17).
 *
 * 가져오기: Rust 열기 창(경로는 웹뷰가 보내지 않는다) → Rust 가 검사하고 임시 보관 → 미리 보기 창(다른 사람이 만든 파일 안내,
 * 라이선스) → "설치" → 이름·만든 사람·라이선스를 적은 확인 → 설치하고 그 스킨으로 바꾼다. 같은 id 의 다른 스킨이 있으면
 * 바꿀지 한 번 더 묻는다. 어느 단계에서든 그만두면 임시 보관한 팩을 버린다. 확인 없이는 아무것도 설치하지 않는다.
 * 내보내기: Rust 가 검사를 다시 통과한 팩을 만들어 Rust 저장 창으로 쓴다.
 */
import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import type { InvokeFn } from '../../integrations/netIpc';
import { t } from '../../i18n/t';
import { confirmDialog, openDialog } from '../../labnote/host/dialogStore';
import { notify as toast } from '../../labnote/host/toastStore';
import { layoutStore } from '../../ui/layoutStore';
import { BUILTIN_SKIN_ID } from './builtin';
import { discardStagedSkin, exportSkin, installSkin, listSkins, pickSkinFile, skinErrorText, toSkinError, type StagedSkin } from './store';
import type { SkinManifest } from './types';
import type { SkinUrls } from './useSkin';

type Notify = (kind: 'info' | 'warn', message: string) => void;

export interface ImportDeps {
  invoke?: InvokeFn;
  /** 미리 보기의 blob 주소(테스트). */
  urls?: SkinUrls;
  notify?: Notify;
  /** 설치한 스킨으로 바꾼다(기본: 이 PC 의 ui.json pet.skin). */
  setSkin?: (id: string) => void;
}

/** 미리 보기 창. 'install' 이면 설치하겠다는 뜻, 닫으면 undefined. */
export function skinImportDialog(staged: StagedSkin, urls?: SkinUrls): Promise<'install' | undefined> {
  return openDialog<'install' | undefined>({ kind: 'skinImport', staged, urls }, undefined);
}

/** 파일을 골라 미리 보고, 확인을 받아 설치한다. 설치한 스킨의 manifest, 그만두거나 실패하면 undefined. */
export async function importSkinFile(deps: ImportDeps = {}): Promise<SkinManifest | undefined> {
  const invoke = deps.invoke ?? tauriInvoke;
  const notify = deps.notify ?? toast;
  let staged: StagedSkin | null;
  try {
    staged = await pickSkinFile(invoke);
  } catch (e) {
    notify('warn', t('skin.importFailed', skinErrorText(e)));
    return undefined;
  }
  if (!staged) return undefined;
  if ((await skinImportDialog(staged, deps.urls)) !== 'install') {
    await discardStagedSkin(staged.stagingId, invoke).catch(() => undefined);
    return undefined;
  }
  return confirmAndInstall(staged, { ...deps, invoke, notify });
}

/**
 * 임시 보관한 팩을 확인을 받고 설치한다(가져오기와 갤러리가 함께 쓴다). 확인 창은 스킨 이름·만든 사람·라이선스를 적는다.
 * 같은 id 의 다른 스킨이 있으면 바꿀지 한 번 더 묻는다. 그만두거나 실패하면 임시 보관한 팩을 버린다. 설치하면 그 스킨으로 바꾼다.
 */
export async function confirmAndInstall(
  staged: { stagingId: string; manifest: SkinManifest },
  deps: ImportDeps = {},
): Promise<SkinManifest | undefined> {
  const invoke = deps.invoke ?? tauriInvoke;
  const notify = deps.notify ?? toast;
  const setSkin = deps.setSkin ?? ((id: string) => layoutStore.setPet({ skin: id }));
  const drop = () => discardStagedSkin(staged.stagingId, invoke).catch(() => undefined);
  const { manifest } = staged;
  const ok = await confirmDialog(t('skin.installConfirm', manifest.name, manifest.author, manifest.licence), {
    confirmLabel: t('skin.import.install'),
  });
  if (!ok) {
    await drop();
    return undefined;
  }
  try {
    let installed: SkinManifest;
    try {
      installed = await installSkin(staged.stagingId, false, invoke);
    } catch (e) {
      if (toSkinError(e).kind !== 'exists') throw e;
      const replace = await confirmDialog(t('skin.replaceConfirm', manifest.name), { confirmLabel: t('skin.replace') });
      if (!replace) {
        await drop();
        return undefined;
      }
      installed = await installSkin(staged.stagingId, true, invoke);
    }
    setSkin(installed.id);
    notify('info', t('skin.installed', installed.name));
    return installed;
  } catch (e) {
    await drop();
    notify('warn', t('skin.installFailed', skinErrorText(e)));
    return undefined;
  }
}

export interface ExportDeps {
  invoke?: InvokeFn;
  notify?: Notify;
}

/** 스킨 `id` 를 팩 파일로 저장한다(Rust 저장 창). 저장했으면 true. 닫으면 아무 말 없이 false. */
export async function exportSkinFile(id: string, deps: ExportDeps = {}): Promise<boolean> {
  const notify = deps.notify ?? toast;
  try {
    const saved = await exportSkin(id, deps.invoke ?? tauriInvoke);
    if (saved) notify('info', t('skin.exported'));
    return saved;
  } catch (e) {
    notify('warn', t('skin.exportFailed', skinErrorText(e)));
    return false;
  }
}

/**
 * 지금 도우미가 쓰는 스킨의 id. 이 PC 의 ui.json 에 적힌 스킨이 설치되어 있지 않으면 도우미는 기본 스킨으로 보이므로
 * 기본 스킨을 내보낸다.
 */
export async function activeSkinForExport(invoke: InvokeFn = tauriInvoke): Promise<string> {
  const id = layoutStore.get().pet.skin;
  if (id === BUILTIN_SKIN_ID) return id;
  const installed = await listSkins(invoke).catch(() => []);
  return installed.some((m) => m.id === id) ? id : BUILTIN_SKIN_ID;
}
