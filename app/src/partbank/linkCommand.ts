/**
 * "labnoteO 링크 열기"(SP6 D14). 앱은 OS 주소 체계를 등록하지 않는다: partbank 의 단추가 만드는 `obsidian://labnoteo-import`
 * 와 `obsidian://labnoteo-open` 을 앱이 가로채면 Obsidian 이 깨진다. 대신 이 명령이 링크를 받아(클립보드에 링크가 있으면 미리
 * 채운다) 옮겨 온 처리기(port/partbankUri, port/labnoteOpenUri)에 넘긴다. 나중에 주소 체계를 등록하면 `labnoteo://` 꼴도 이미
 * 읽으니 그 작업 하나로 끝난다.
 *
 * 링크는 어떤 웹 페이지든 만들 수 있다: 꼴이 맞는지만 여기서 보고, 매개변수 검사는 처리기가 한다. `server` 는 설정된 연결을
 * 고르기만 하고 주소가 되지 않는다(clientForOrigin).
 */
import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { t } from '../i18n/t';
import type { InvokeFn } from '../integrations/netIpc';
import type { CommandContext } from '../labnote/commands/context';
import { overrideOr } from '../labnote/i18n';
import { handleOpenUri } from '../labnote/port/labnoteOpenUri';
import type { PartbankFeature } from '../labnote/port/partbankFeature';
import { handleImportUri } from '../labnote/port/partbankUri';
import { createSampleEnv } from '../samples/env';
import { readClipboardLink } from './clipboardIpc';
import { partbank } from './current';

export type LabnoteoLink = { action: 'import' | 'open'; params: Record<string, string> };

/**
 * 받는 꼴은 정확히 넷: `obsidian://labnoteo-import?…`, `obsidian://labnoteo-open?…`, `labnoteo://import?…`,
 * `labnoteo://open?…`. 앞뒤 공백은 지우고, 체계와 동작 이름의 대소문자는 가리지 않는다. 링크 안에 공백이 있거나 앞에 다른
 * 글이 붙으면 링크가 아니다.
 */
const LINK_RE = /^(?:obsidian:\/\/labnoteo-|labnoteo:\/\/)(import|open)\/?(?:\?([^#\s]*))?(?:#\S*)?$/i;

export function parseLabnoteoLink(text: string): LabnoteoLink | undefined {
  const m = LINK_RE.exec(text.trim());
  if (!m) return undefined;
  const params: Record<string, string> = {};
  try {
    // 같은 이름이 거듭 오면 처음 것을 쓴다
    for (const [k, v] of new URLSearchParams(m[2] ?? '')) if (!Object.hasOwn(params, k)) params[k] = v;
  } catch {
    return undefined;
  }
  return { action: m[1].toLowerCase() as LabnoteoLink['action'], params };
}

/** 열린 보관함의 이름(VaultInfo.name). 묻지 못하면 undefined. */
async function currentVaultName(invoke: InvokeFn): Promise<string | undefined> {
  try {
    const v = await invoke<{ name?: unknown } | null>('vault_current', {});
    return typeof v?.name === 'string' ? v.name : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `app.open-labnoteo-link`. 클립보드는 링크일 때만 입력란에 미리 채운다(다른 글은 보이지 않는다). 잘못된 링크는 입력란이
 * 바로 알려 주고, 그래도 들어오면 'partbank.linkInvalid' 를 알린다. `deps` 는 테스트가 넣는다: 기본은 지금 보관함의
 * PartbankFeature 와 Tauri invoke.
 */
export async function runOpenLabnoteoLink(
  ctx: CommandContext,
  readClipboard?: () => Promise<string>,
  deps: { feature?: PartbankFeature; invoke?: InvokeFn } = {},
): Promise<void> {
  // 웹 클립보드(navigator.clipboard)는 WebView2 가 권한을 먼저 묻는다: Rust 가 링크 꼴인 글만 돌려준다(SP6-B1).
  const read = readClipboard ?? (() => readClipboardLink(deps.invoke ?? tauriInvoke));
  let clip = '';
  try {
    clip = (await read()) ?? '';
  } catch {
    clip = '';
  }
  const prefill = parseLabnoteoLink(clip) ? clip.trim() : '';
  const value = await ctx.host.prompt({
    title: t('cmd.openLabnoteoLink'),
    prompt: t('partbank.linkPrompt'),
    value: prefill,
    validate: (v) => (parseLabnoteoLink(v) ? null : t('partbank.linkInvalid')),
  });
  if (value === undefined) return;
  const link = parseLabnoteoLink(value);
  if (!link) {
    ctx.host.notify('warn', t('partbank.linkInvalid'));
    return;
  }

  const env = createSampleEnv(ctx);
  if (link.action === 'open') {
    // Obsidian 은 `vault` 로 보관함을 골랐다. 앱에는 열린 보관함 하나뿐이니, 다른 보관함을 가리키면 열지 않는다.
    const wanted = (link.params.vault ?? '').trim();
    if (wanted) {
      const name = await currentVaultName(deps.invoke ?? (tauriInvoke as InvokeFn));
      if (name === undefined || name.toLowerCase() !== wanted.toLowerCase()) {
        ctx.host.notify('warn', t('partbank.linkOtherVault', wanted));
        return;
      }
    }
    await handleOpenUri(env, link.params);
    return;
  }

  const feature = 'feature' in deps ? deps.feature : partbank(ctx);
  if (!feature) {
    // plugin: 'Set up a partbank connection in the plugin settings first.'
    ctx.host.notify('info', overrideOr('partbank.setupFirst'));
    return;
  }
  await handleImportUri(env, feature, link.params);
}
