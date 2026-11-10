import { useState } from 'react';
import { t } from '../i18n/t';
import { useLang } from '../i18n/useLang';
import { DialogFrame } from '../labnote/host/DialogFrame';
import type { DialogSpec } from '../labnote/host/dialogStore';
import type { DivergedFile } from '../integrations/githubIpc';
import type { DivergedAnswer } from './githubFlow';

export type DivergedSpec = { kind: 'githubDiverged'; files: DivergedFile[] };

function changeLabel(f: DivergedFile): string {
  if (f.goneHere) return t('github.diverged.goneHere');
  switch (f.change) {
    case 'new':
      return t('github.preview.badgeNew');
    case 'deleted':
      return t('github.preview.badgeDeleted');
    default:
      return t('github.preview.badgeChanged');
  }
}

/**
 * spec §8.3: GitHub 에 있는 내용이 바뀌었을 때. 바뀐 파일을 보이고, "내 폴더 내용으로 올리기" 는 확인 칸을 켜야 눌린다.
 * 고급의 "따로 올리기" 는 GitHub 내용을 그대로 둔다. 보관함에는 아무것도 쓰지 않는다.
 */
export function DivergedDialog(props: {
  spec: Extract<DialogSpec, { kind: 'githubDiverged' }>;
  onDone: (value: DivergedAnswer) => void;
  onCancel: () => void;
}) {
  useLang();
  const { files } = props.spec;
  const [ack, setAck] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const paths = files.map((f) => f.path);
  return (
    <DialogFrame title={t('github.diverged.title')} className="github-dialog github-diverged" onCancel={props.onCancel}>
      <div className="github-form">
        <p>
          <strong>{t('github.diverged.files')}</strong>
        </p>
        <ul className="github-diverged-files">
          {files.map((f) => (
            <li key={f.path}>
              <code>{f.path}</code> ({changeLabel(f)})
            </li>
          ))}
        </ul>
        <p className="prompt-hint">{t('github.diverged.mineHelp')}</p>
        {files.length > 0 ? (
          <label className="github-ack">
            <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> {t('github.diverged.ack')}: {paths.join(', ')}
          </label>
        ) : null}
        <div className="github-advanced">
          <button type="button" className="github-disclosure" aria-expanded={advanced} onClick={() => setAdvanced((v) => !v)}>
            {t('github.settings.advanced')}
          </button>
          {advanced ? (
            <div className="github-actions">
              <button type="button" onClick={() => props.onDone({ mode: 'separate', ack: [] })}>
                {t('github.diverged.separate')}
              </button>
            </div>
          ) : null}
        </div>
        <div className="dialog-actions">
          <button type="button" onClick={props.onCancel}>
            {t('dialog.cancel')}
          </button>
          <button type="button" className="primary" disabled={files.length > 0 && !ack} onClick={() => props.onDone({ mode: 'mine', ack: paths })}>
            {t('github.diverged.mine')}
          </button>
        </div>
      </div>
    </DialogFrame>
  );
}
