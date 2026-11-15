import { Channel, invoke as tauriInvoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';

/** The pet page's whole window onto Tauri. Tests inject a fake. The pet window has no event permission: events from the
 * main window arrive over one channel (`pet_subscribe`), and it sends its own with `pet_to_main` (two fixed names). */
export interface PetIpc {
  invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown>;
  listen(event: string, fn: (payload: unknown) => void): Promise<() => void>;
  emit(event: string, payload: unknown): Promise<void>;
  startDragging(): Promise<void>;
}

const handlers = new Map<string, Set<(payload: unknown) => void>>();
let subscribed: Promise<unknown> | null = null;

function subscribe(): Promise<unknown> {
  if (!subscribed) {
    const channel = new Channel<{ event?: unknown; payload?: unknown }>();
    channel.onmessage = (msg) => {
      if (!msg || typeof msg.event !== 'string') return;
      for (const fn of handlers.get(msg.event) ?? []) fn(msg.payload);
    };
    subscribed = Promise.resolve(tauriInvoke('pet_subscribe', { onEvent: channel })).catch((e) => {
      subscribed = null;
      throw e;
    });
  }
  return subscribed;
}

export const tauriPetIpc: PetIpc = {
  invoke: (cmd, args) => tauriInvoke(cmd, args),
  async listen(event, fn) {
    let set = handlers.get(event);
    if (!set) handlers.set(event, (set = new Set()));
    set.add(fn);
    await subscribe();
    return () => void set!.delete(fn);
  },
  async emit(event, payload) {
    await tauriInvoke('pet_to_main', { event, payload });
  },
  startDragging: () => getCurrentWindow().startDragging(),
};
