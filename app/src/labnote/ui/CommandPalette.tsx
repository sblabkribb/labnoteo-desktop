import { useEffect, useRef } from 'react';
import type { PickItem } from '@labnoteo/core';
import { getLang } from '../../i18n/lang';
import { catalogs, t } from '../../i18n/t';
import { appCommands, asCommand, displayKey, type AppCommand } from '../../editor/commands/appCommands';
import type { IconName } from '../../ui/Icon';
import type { CommandContext } from '../commands/context';
import { commands, type Command } from '../commands/registry';
import { runCommand } from '../commands/runCommand';
import { currentDialog } from '../host/dialogStore';
import { koTerms, paletteName, vendorKo } from '../i18n';
import { closeMenu } from './menuStore';
import {
  comparePalette,
  PALETTE_GROUPS,
  paletteEntry,
  paletteGroupLabel,
  paletteLabel,
  paletteLabels,
  paletteNeedReason,
  termVariants,
  unmetNeed,
} from './paletteCatalog';

function available(c: Command | AppCommand, ctx: CommandContext): boolean {
  try {
    return c.available ? c.available(ctx) : true;
  } catch {
    return true; // 판단이 실패한 명령은 숨기지 않는다: 돌리면 runCommand 가 이유를 알린다
  }
}

function activePathOf(ctx: CommandContext): string | undefined {
  try {
    return ctx.activePath();
  } catch {
    return undefined;
  }
}

/** 팔레트 한 줄의 값: 돌릴 명령과 그 줄의 아이콘·단축키, 지금 못 쓰면 그 이유. */
export interface PaletteRow {
  command: Command;
  icon?: IconName;
  kbd?: string;
  /** 열린 노트가 맞지 않아 지금은 못 쓴다: 흐리게 보이고, 고르면 이 이유만 알린다. */
  disabled?: string;
  /** 묶음 머리(지금 언어). 차림표에 없는 명령은 없다("그 밖의 명령"). */
  group?: string;
}

/** 명령의 옛 이름들: 플러그인 이름(영어 키, 플러그인 한국어 원문 '워크플로 생성', 용어 규칙을 쓴 'Workflow 생성'), 예전 팔레트 이름. */
function vendorOldNames(c: Command): string[] {
  const ko = vendorKo(c.nameKey);
  return [c.nameKey, paletteName(c.nameKey), ...(ko !== undefined ? [ko, koTerms(ko).replace(/시료/g, '샘플')] : [])];
}

function appOldNames(c: AppCommand): string[] {
  return [catalogs.ko[c.nameKey], catalogs.en[c.nameKey]].filter((s): s is string => s !== undefined);
}

/**
 * 찾기 낱말: id, 옛 이름, 두 언어의 팔레트 이름, 별칭, 그리고 그것들의 용어 변형('Workflow' → '워크플로'), 단축키.
 * 보이는 이름과 같은 것과 겹치는 것은 뺀다.
 */
function keywordsOf(id: string, label: string, oldNames: string[], kbd: string | undefined): string[] {
  const names = [...oldNames, ...paletteLabels(id), ...(paletteEntry(id)?.aliases ?? [])];
  const all = [id, ...names, ...names.flatMap(termVariants), ...(kbd ? [kbd] : [])];
  return [...new Set(all)].filter((k) => k !== label);
}

/**
 * 팔레트의 줄들(보이는 차례): 묶음 차례(PALETTE_GROUPS), 묶음 안에서는 쓸 수 있는 것 먼저(자주 쓰는 것 → 이름순 → 드문 것),
 * 열린 노트가 맞지 않아 못 쓰는 것은 묶음 끝에 흐리게 이유와 함께. 설정·상태로 못 쓰는 명령(available 이 false)은 숨긴다.
 * 차림표에 없는 명령은 맨 끝의 "그 밖의 명령"에 원래 이름으로.
 */
export function paletteItems(ctx: CommandContext): PickItem<PaletteRow>[] {
  const active = activePathOf(ctx);
  const rows: { id: string; label: string; dimmed: boolean; item: PickItem<PaletteRow> }[] = [];
  const add = (c: Command | AppCommand, command: () => Command, fallback: string, oldNames: string[], key: string | undefined) => {
    const entry = paletteEntry(c.id);
    const need = unmetNeed(entry, active);
    if (need === undefined && !available(c, ctx)) return;
    const label = paletteLabel(c.id) ?? fallback;
    const kbd = key ? displayKey(key) : undefined;
    const disabled = need !== undefined ? paletteNeedReason(need) : undefined;
    rows.push({
      id: c.id,
      label,
      dimmed: disabled !== undefined,
      item: {
        label,
        keywords: keywordsOf(c.id, label, oldNames, kbd),
        ...(disabled !== undefined ? { description: disabled, dimmed: true } : {}),
        value: { command: command(), icon: c.icon, kbd, disabled, group: entry ? paletteGroupLabel(entry.group) : undefined },
      },
    });
  };
  for (const c of commands()) add(c, () => c, paletteName(c.nameKey), vendorOldNames(c), c.shortcut);
  for (const c of appCommands()) if (c.inPalette !== false) add(c, () => asCommand(c), t(c.nameKey), appOldNames(c), c.key);
  const lang = getLang();
  const groupIndex = (id: string) => {
    const e = paletteEntry(id);
    return e ? PALETTE_GROUPS.indexOf(e.group) : PALETTE_GROUPS.length;
  };
  rows.sort((a, b) => comparePalette(a, b, lang));
  // 묶음 안에서 흐린 줄(못 쓰는 것)은 끝으로: 정렬은 안정적이라 그 밖의 차례는 그대로다
  rows.sort((a, b) => groupIndex(a.id) - groupIndex(b.id) || Number(a.dimmed) - Number(b.dimmed));
  return rows.map((r) => r.item);
}

/** 최근 고른 명령을 적는 이름(이 사람의 편의, localStorage). */
export const PALETTE_RECENT_KEY = 'command';

/**
 * 명령 팔레트: 명령을 host.pick 의 팔레트 꼴로 고르게 하고, 고른 명령을 runCommand 로 돌린다(paletteCatalog.ts 의 차림표).
 * - 검색어가 없으면 "최근 사용"(id 로 기억한다), 그다음 목적별 묶음(노트·편집, 실험·Workflow·Unit Operation, 샘플, AI·어시스턴트,
 *   연결 서비스, 보기·창, 설정·도움말)을 머리와 함께 보인다.
 * - 이름은 지금 언어의 팔레트 이름 하나. 옛 이름, 다른 언어의 이름, id, 단축키로도 찾는다.
 * - 줄마다 아이콘과 오른쪽 끝의 단축키 칩. 흐린 줄을 고르면 이유만 알리고 돌리지 않는다.
 */
export async function openPalette(ctx: CommandContext): Promise<void> {
  const row = (item: PickItem<unknown>) => item.value as PaletteRow;
  const chosen = await ctx.host.pick(paletteItems(ctx), {
    title: t('palette.title'),
    placeholder: t('palette.placeholder'),
    palette: { iconOf: (item) => row(item).icon, kbdOf: (item) => row(item).kbd, hint: t('palette.hint') },
    recentKey: PALETTE_RECENT_KEY,
    recentHead: t('palette.recent'),
    groupOf: (item) => row(item).group,
    restHead: t('palette.other'),
    recentId: (item) => row(item).command.id,
  });
  if (!chosen) return;
  if (chosen.disabled !== undefined) {
    ctx.host.notify('info', chosen.disabled);
    return;
  }
  await runCommand(ctx, chosen.command);
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
