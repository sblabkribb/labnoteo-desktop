import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { t } from '../i18n/t';
import type { AppHost } from '../labnote/host/createAppHost';
import { notifySecretsChange, type SecretStatus } from './secretsEvents';

type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

/**
 * 플러그인 data.json 에 LLM 키가 있을 때(D9): 가져가지 않고 *제안*한다. 보관함이 동료에게서 왔을 수 있다.
 * 예를 고르면 Rust 가 data.json 을 다시 읽어 Windows 자격 증명 관리자에 저장한다(값은 IPC 를 건너지 않는다).
 * 어느 쪽이든 data.json 에 키가 평문으로 남아 있다고 한 번 알린다. data.json 은 고치지 않는다.
 * 던지지 않는다: 저장에 실패하면 알림 한 줄이고, Rust 의 원래 오류 글은 보이지 않는다.
 */
export async function offerPluginLlmKey(
  host: Pick<AppHost, 'confirm' | 'notify'>,
  invoke: InvokeFn = tauriInvoke,
): Promise<void> {
  const yes = await host.confirm(t('ai.importKeyConfirm'), { confirmLabel: t('ai.importKeyYes') });
  if (yes) {
    try {
      await invoke<boolean>('settings_import_llm_key', {});
      try {
        notifySecretsChange(await invoke<SecretStatus>('secret_status', {}));
      } catch {
        // 상태를 읽지 못해도 키는 저장됐다. 다음에 설정 대화상자를 열면 새 상태를 읽는다.
      }
    } catch {
      host.notify('error', t('ai.importKeyFailed'));
    }
  }
  host.notify('warn', t('ai.importKeyPlaintext'));
}
