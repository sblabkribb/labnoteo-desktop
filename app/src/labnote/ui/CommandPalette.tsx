import { useEffect, useRef } from 'react';
import type { PickItem } from '@labnoteo/core';
import { t } from '../../i18n/t';
import { appCommands, displayKey, type AppCommand } from '../../editor/commands/appCommands';
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

/** 앱 명령을 runCommand 가 받는 꼴로 감싼다(run 이 동기여도 된다). */
function asCommand(c: AppCommand): Command {
  return { id: c.id, nameKey: c.nameKey, run: async (ctx) => c.run(ctx) };
}

/**
 * 명령 팔레트: 지금 쓸 수 있는 명령을 host.pick 으로 고르게 하고, 고른 명령을 runCommand 로 돌린다.
 * 이름은 열 때 만든다(한국어: '실험 생성 (Create experiment)', 영어: 'Create experiment'). id 와 영어 키로도 찾는다.
 */
export async function openPalette(ctx: CommandContext): Promise<void> {
  const vendor: PickItem<Command>[] = commands()
    .filter((c) => available(c, ctx))
    .map((c) => ({ label: paletteName(c.nameKey), keywords: [c.id, c.nameKey], value: c }));
  const app: PickItem<Command>[] = appCommands()
    .filter((c) => available(c, ctx))
    .map((c) => ({
      label: c.key ? `${t(c.nameKey)} (${displayKey(c.key)})` : t(c.nameKey),
      keywords: c.key ? [c.id, c.nameKey, c.key] : [c.id, c.nameKey],
      value: asCommand(c),
    }));
  const items = [...vendor, ...app];
  const chosen = await ctx.host.pick(items, { title: t('palette.title'), placeholder: t('palette.placeholder') });
  if (chosen) await runCommand(ctx, chosen);
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
