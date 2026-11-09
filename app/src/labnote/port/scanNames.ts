// Ported from app/vendor/labnoteo/src/scan/imageStore.ts:23-39 sha256:09ac3e4d98c767a0
// labnoteO 0.140.2, Apache-2.0.
// Changes: none.
/** `LN-7K3M9QX2_u3_p2_20261015.jpg` (unit op 0: pages before the first unit op). */
export function scanFileName(noteId: string, unitOpIndex: number, page: number, date: string): string {
  return `${noteId}_u${unitOpIndex}_p${page}_${date.replace(/-/g, '')}.jpg`;
}

/**
 * The note ID in a filed scan's embed line (`![[LN-7K3M9QX2_u3_p2_20261015.jpg|200]]`,
 * with or without a folder, or as a Markdown link), by the naming above.
 */
export function noteIdFromFiledScanEmbed(embed: string): string | undefined {
  return /(?:^|[/[(])(LN-[0-9A-HJKMNP-TV-Z]{8})_u\d+_p\d+_\d{8}(?:_\d+)?\.(?:jpe?g|png)/i.exec(embed)?.[1];
}

/** Whether `name` is a scan of note `noteId`, by the naming above. */
export function isScanOfNote(name: string, noteId: string): boolean {
  return name.startsWith(`${noteId}_u`) && /\.(jpe?g|png)$/i.test(name);
}
