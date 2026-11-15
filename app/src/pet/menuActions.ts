export type MenuAction = 'hide' | 'quiet' | 'open';

export const MENU_ITEMS: ReadonlyArray<{ action: MenuAction; labelKey: string }> = [
  { action: 'hide', labelKey: 'pet.desktop.menu.hide' },
  { action: 'quiet', labelKey: 'pet.desktop.menu.quiet' },
  { action: 'open', labelKey: 'pet.desktop.menu.open' },
];

export interface MenuDeps {
  quiet: boolean;
  hide(): Promise<void>;
  setQuiet(quiet: boolean): Promise<void>;
  openMain(): Promise<void>;
}

/** The only code path that raises the main window is the `open` action. */
export async function runMenuAction(action: MenuAction, deps: MenuDeps): Promise<void> {
  if (action === 'hide') return deps.hide();
  if (action === 'quiet') return deps.setQuiet(!deps.quiet);
  if (action === 'open') return deps.openMain();
}
