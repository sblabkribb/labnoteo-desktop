/**
 * Test harness: the assistant panel (Bubble) driven by the pet store and a session, without the desktop window. The open
 * flag, close and hide go through the store as they do in the app; the session follows `activePath`.
 */
import { useId, useSyncExternalStore } from 'react';
import { Bubble } from '../Bubble';
import type { BubbleActions } from '../MessageView';
import type { PetStore } from '../petStore';
import { useAssistantSession, type AssistantSession } from '../useAssistantSession';

export function PanelHarness(props: { store: PetStore; session: AssistantSession; activePath?: string; actions?: BubbleActions }) {
  const snap = useSyncExternalStore(props.store.subscribe, props.store.get);
  const chat = useAssistantSession({ activePath: props.activePath, session: props.session });
  const id = useId();
  if (snap.hidden || !snap.open) return null;
  return (
    <Bubble
      id={id}
      onClose={() => props.store.setOpen(false)}
      onHide={() => props.store.setHidden(true)}
      chat={chat}
      activePath={props.activePath}
      actions={props.actions}
    />
  );
}
