/**
 * The clipboard for "Open labnoteO link" (SP6-B1). `navigator.clipboard.readText()` makes WebView2 show its own
 * permission bubble and waits on it, so Rust reads the clipboard instead and answers only text shaped like a labnoteO
 * link (anything else, such as a copied MCP token, stays out of the webview): the link, or null.
 */
import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import type { InvokeFn } from '../integrations/netIpc';

export async function readClipboardLink(invoke: InvokeFn = tauriInvoke): Promise<string> {
  const link = await invoke<string | null>('clipboard_labnoteo_link', {});
  return typeof link === 'string' ? link : '';
}
