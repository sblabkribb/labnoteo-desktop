import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { emit as tauriEmit, listen as tauriListen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';

/** The pet page's whole window onto Tauri. The only file in src/pet/ that imports @tauri-apps/api; tests inject a fake. */
export interface PetIpc {
  invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown>;
  listen(event: string, fn: (payload: unknown) => void): Promise<() => void>;
  emit(event: string, payload: unknown): Promise<void>;
  startDragging(): Promise<void>;
}

export const tauriPetIpc: PetIpc = {
  invoke: (cmd, args) => tauriInvoke(cmd, args),
  listen: (event, fn) => tauriListen(event, (e) => fn(e.payload)),
  emit: (event, payload) => tauriEmit(event, payload),
  startDragging: () => getCurrentWindow().startDragging(),
};
