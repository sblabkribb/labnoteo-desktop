// Ported from app/vendor/labnoteo/src/dateFieldPicker.ts:226-233 sha256:ad49a4b99b89f2bf
// Ported from app/vendor/labnoteo/src/dateFieldPicker.ts:242-244 sha256:4db9c54d4c6336d2
// labnoteO 0.140.2, Apache-2.0.
// Changes: only the check rules of the Meta date picker. warnIfOutOfOrder (End_date earlier than its Start_date, #192) and the picked-year check (#308) become one pure function, checkDates(start, end), over the two stored values; the picker's "unreadable stored value" notice (#364) becomes its 'unreadable' result. The Notice calls stay with the caller (editor/live/dateChip.ts), which uses the app's toasts and i18n keys date.endBeforeStart / date.implausibleYear / date.unreadable. The rules themselves are the core's isEndBeforeStart, isPlausibleMetaDate and toDateTimeLocalValue, unchanged.
import { isEndBeforeStart, isPlausibleMetaDate, toDateTimeLocalValue } from '@labnoteo/core/lib/dateUtils';

export type DateCheck = 'ok' | 'endBeforeStart' | 'implausibleYear' | 'unreadable';

/**
 * What is wrong with a UO's Meta `Start_date` / `End_date` pair, first problem first: a filled value that does not
 * read as a date, a year outside 1900–2100, then an End_date earlier than the Start_date (a value without a time
 * compares by day). Empty values are fine: an unfinished block raises nothing.
 */
export function checkDates(start: string, end: string): DateCheck {
  const values = [start, end].map((v) => v.trim()).filter((v) => v !== '');
  const read = values.map(toDateTimeLocalValue);
  if (read.some((v) => v === '')) return 'unreadable';
  if (read.some((v) => !isPlausibleMetaDate(v))) return 'implausibleYear';
  if (isEndBeforeStart(start, end)) return 'endBeforeStart';
  return 'ok';
}
