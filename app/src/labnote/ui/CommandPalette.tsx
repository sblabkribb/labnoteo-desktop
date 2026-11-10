import { useEffect, useRef } from 'react';
import type { PickItem } from '@labnoteo/core';
import { t } from '../../i18n/t';
import { appCommands, asCommand, displayKey, type AppCommand } from '../../editor/commands/appCommands';
import type { IconName } from '../../ui/Icon';
import type { CommandContext } from '../commands/context';
import { commands, type Command } from '../commands/registry';
import { runCommand } from '../commands/runCommand';
import { currentDialog } from '../host/dialogStore';
import { paletteName } from '../i18n';
import { closeMenu } from './menuStore';

function available(c: Command | AppCommand, ctx: CommandContext): boolean {
  try {
    return c.available ? c.available(ctx) : true;
  } catch {
    return true; // 판단이 실패한 명령은 숨기지 않는다: 돌리면 runCommand 가 이유를 알린다
  }
}

/** 팔레트 한 줄의 값: 돌릴 명령과 그 줄의 아이콘·단축키. */
interface Entry {
  command: Command;
  icon?: IconName;
  kbd?: string;
}

/** 최근 고른 명령을 적는 이름(이 사람의 편의, localStorage). */
export const PALETTE_RECENT_KEY = 'command';

/**
 * 명령 팔레트: 지금 쓸 수 있는 명령을 host.pick 의 팔레트 꼴로 고르게 하고, 고른 명령을 runCommand 로 돌린다.
 * - 이름은 열 때 만든다(한국어: '실험 생성 (Create experiment)', 영어: 'Create experiment'). id 와 영어 키, 단축키로도 찾는다.
 * - 줄마다 아이콘과 오른쪽 끝의 단축키 칩. 검색어가 없으면 최근 고른 명령(id 로 기억한다)이 "최근" 묶음으로 맨 위에 온다.
 */
export async function openPalette(ctx: CommandContext): Promise<void> {
  const vendor: PickItem<Entry>[] = commands()
    .filter((c) => available(c, ctx))
    .map((c) => ({
      label: paletteName(c.nameKey),
      keywords: [c.id, c.nameKey],
      value: { command: c, icon: c.icon, kbd: c.shortcut ? displayKey(c.shortcut) : undefined },
    }));
  const app: PickItem<Entry>[] = appCommands()
    .filter((c) => c.inPalette !== false && available(c, ctx))
    .map((c) => {
      const kbd = c.key ? displayKey(c.key) : undefined;
      return {
        label: t(c.nameKey),
        keywords: kbd ? [c.id, c.nameKey, kbd] : [c.id, c.nameKey],
        value: { command: asCommand(c), icon: c.icon, kbd },
      };
    });
  const entry = (item: PickItem<unknown>) => item.value as Entry;
  const chosen = await ctx.host.pick([...vendor, ...app], {
    title: t('palette.title'),
    placeholder: t('palette.placeholder'),
    palette: { iconOf: (item) => entry(item).icon, kbdOf: (item) => entry(item).kbd, hint: t('palette.hint') },
    recentKey: PALETTE_RECENT_KEY,
    recentId: (item) => entry(item).command.id,
  });
  if (chosen) await runCommand(ctx, chosen.command);
}

/** Ctrl+P 와 Ctrl+Shift+P. 한글 자판에서는 key 가 'ㅔ' 이므로 물리 키(code)로도 본다. */
export function isPaletteKey(e: KeyboardEvent): boolean {
  return e.ctrlKey && !e.altKey && !e.metaKey && (e.code === 'KeyP' || e.key.toLowerCase() === 'p');
}

/**
 * 팔레트 단축키. window 의 캡처 단계에서 듣는다: 키보드 이벤트는 composed 라 편집기의 그림자 루트(표 칸 포함) 안에서
 * 시작해도 먼저 여기에 온다. 늘 preventDefault 해 WebView2 의 인쇄 대화상자를 막는다. 대화상자가 열려 있거나
 * 맥락이 아직 없으면(설정을 읽는 중) 팔레트는 열지 않는다.
 */
export function usePaletteHotkey(ctx: CommandContext | undefined): void {
  const latest = useRef(ctx);
  latest.current = ctx;
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!isPaletteKey(e)) return;
      e.preventDefault();
      e.stopPropagation();
      const c = latest.current;
      if (e.repeat || !c || currentDialog() !== null) return;
      closeMenu();
      void runCommand(c, () => openPalette(c));
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);
}
