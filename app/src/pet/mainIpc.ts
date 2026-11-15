import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { listen as tauriListen } from '@tauri-apps/api/event';

/** The main window's side of the pet events (used by mainBridge.ts). Sending to the pet goes through `pet_relay`, which
 * accepts three fixed event names and delivers them over the pet's own channel (the pet window cannot listen on the bus). */
export const tauriMainIpc = {
  invoke: (cmd: string, args?: Record<string, unknown>) => tauriInvoke(cmd, args),
  listen: (event: string, fn: (payload: unknown) => void) => tauriListen(event, (e) => fn(e.payload)),
  emitTo: async (_target: string, event: string, payload: unknown): Promise<void> => {
    await tauriInvoke('pet_relay', { event, payload });
  },
};
