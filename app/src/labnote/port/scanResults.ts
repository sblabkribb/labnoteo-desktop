// Ported from app/vendor/labnoteo/src/scan/resultModal.ts:7-79 sha256:621fa2b59f4f1743
// labnoteO 0.140.2, Apache-2.0.
// Changes: the HEIC and TIFF advice names Obsidian, so it becomes overrideOr('scan.heicAdvice') and
// overrideOr('scan.tiffAdvice') (SP7 B11; the plugin keys stay as comments); the app's own unmatched reason
// 'note-busy' (B9) gets t('scan.noteBusy'); the Translator parameter t is named translate, so the app's own t-key
// check does not read plugin keys as app keys. The dialog half of resultModal.ts is scan/ResultsDialog.tsx.
/** What a batch of scans came to: the summary line and one text per page. */
import type { Translator } from '@labnoteo/core';
import { t as appT } from '../../i18n/t';
import { overrideOr } from '../i18n';
import type { ScanResult } from './scanPipeline';

/** "12 page(s): 10 filed, 1 unmatched, 1 blank". */
export function summarizeResults(translate: Translator, results: readonly ScanResult[]): string {
  const counted = results.filter((r) => r.status !== 'skipped');
  const count = (status: ScanResult['status']) => counted.filter((r) => r.status === status).length;
  const parts: string[] = [];
  const add = (n: number, key: string) => n > 0 && parts.push(translate(key, String(n)));
  add(count('filed'), '{0} filed');
  add(count('duplicate'), '{0} already filed');
  add(count('unmatched'), '{0} unmatched');
  add(count('blank'), '{0} blank');
  add(count('unsupported'), '{0} unsupported');
  add(count('error'), '{0} failed');
  return translate('{0} page(s): {1}', String(counted.length), parts.join(', ') || translate('nothing to do'));
}

export function describeResult(translate: Translator, r: ScanResult): string {
  switch (r.status) {
    case 'filed': {
      const where = r.block ? `${r.notePath ?? ''} › ${r.block}` : (r.notePath ?? '');
      const filed = r.replacedMissing
        ? `${translate('Filed in {0}', where)} ${translate('The note already had this scan, but its image was deleted, so it was filed again in its place.')}`
        : translate('Filed in {0}', where);
      if (r.legacy) {
        return `${filed} ${translate('This printout is from before 0.123.0 and does not say which block it is, so check that it went to the right one.')}`;
      }
      if (r.matchedBy && r.matchedBy !== 'index') {
        return `${filed} ${translate('The block is no longer where it was printed from, so check that the scan went to the right one.')}`;
      }
      return filed;
    }
    case 'duplicate':
      return translate('Already in {0}; skipped', r.notePath ?? '');
    case 'blank':
      return translate('Blank page; skipped');
    case 'skipped':
      if (r.reason === 'cancelled') return translate('Cancelled; the scan is still waiting to be assigned.');
      return translate('No worksheet QR code; left alone');
    case 'error':
      return translate('Failed: {0}', r.message ?? '');
    case 'unsupported':
      switch (r.reason) {
        case 'heic':
          // plugin key: 'HEIC photo, which Obsidian cannot open. On iPhone set Settings → Camera → Formats → Most Compatible, or share the photo as JPEG.'
          return overrideOr('scan.heicAdvice');
        case 'tiff':
          // plugin key: 'TIFF scan, which Obsidian cannot open. Set the scanner to save PDF or JPEG.'
          return overrideOr('scan.tiffAdvice');
        case 'zip-limit':
          return translate('Zip too large: only the first files were read (at most 200 files, 500 MB).');
        case 'pdf-limit':
          return translate('PDF too long: only the first 50 pages were read.');
        default:
          return translate('Not an image, PDF or zip file.');
      }
    case 'unmatched':
      return `${unmatchedReasonText(translate, r.reason ?? 'no-qr', r.payload?.noteId)} ${translate('Assign it with "{0}".', translate('Assign unmatched scans'))}`;
  }
}

/** Why a page was not filed, for the result and the assignment window (#342). */
export function unmatchedReasonText(translate: Translator, reason: string, noteId = ''): string {
  const why: Record<string, string> = {
    'no-qr': translate('No worksheet QR code was found.'),
    'note-not-found': translate('No note has the ID {0}.', noteId),
    'duplicate-id': translate('Several notes share the ID {0}.', noteId),
    'note-only': translate('The QR code names the note but no unit operation.'),
    'no-unit-op': translate('The unit operation it was printed from is no longer in the note.'),
    ambiguous: translate('The note has several unit operations it could belong to.'),
    // A fingerprint no block has: deleted and renamed look the same.
    renamed: translate(
      'The unit operation it was printed from was deleted, or its title or alias changed since, so it is unclear which block it belongs to.',
    ),
    // The app's own reason (B9): the note stayed busy (composing) for 30 s.
    'note-busy': appT('scan.noteBusy'),
  };
  return why[reason] ?? '';
}
