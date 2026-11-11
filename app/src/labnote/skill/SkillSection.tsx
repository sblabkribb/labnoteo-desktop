// The labnoteO SKILL.md section of Integration settings (Task 17, spec §12).
// - On mount it calls only `skill_status`. Nothing is written until the user clicks.
// - Install writes `<home>/.claude/skills/labnoteo/SKILL.md` through Rust; a differing file needs a
//   second, explicit Overwrite click that shows the target path.
// - Copy uses the webview clipboard (the text is already here and not secret); Save as lets Rust
//   show its own dialog. The webview never sends content or a path for a write.
import { useEffect, useState } from 'react';
import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { t } from '../../i18n/t';
import { copyText } from '../../links/clipboard';
import type { InvokeFn } from '../../integrations/netIpc';
import type { Notify } from '../mcp/commands';
import { SKILL_TEXT } from './skillText';
import { skillInstall, skillSaveAs, skillStatus, toSkillError, type SkillStatus } from './skillIpc';
import { skillErrorText, skillStateText } from './skillView';

export interface SkillSectionProps {
  notify: Notify;
  invoke?: InvokeFn;
  /** Puts the text on the clipboard; defaults to the app's `copyText`. Throws when the clipboard refuses. */
  copy?: (text: string) => Promise<void>;
}

export function SkillSection(props: SkillSectionProps) {
  const { notify } = props;
  const invoke = props.invoke ?? (tauriInvoke as InvokeFn);
  const copy = props.copy ?? ((text: string) => copyText(text, notify));
  const [status, setStatus] = useState<SkillStatus>();
  const [error, setError] = useState<string>();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const refresh = async (): Promise<SkillStatus | undefined> => {
    try {
      const s = await skillStatus(invoke);
      setStatus(s);
      return s;
    } catch (e) {
      setError(skillErrorText(toSkillError(e)));
      return undefined;
    }
  };

  useEffect(() => {
    void refresh();
    // Once: invoke stays the same while the dialog is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const install = async (overwrite: boolean) => {
    if (busy) return;
    setBusy(true);
    setConfirming(false);
    setError(undefined);
    try {
      const { written } = await skillInstall(overwrite, invoke);
      const s = await refresh();
      notify('info', written ? t('skill.installed', s?.target ?? status?.target ?? '') : t('skill.upToDate'));
    } catch (e) {
      setError(skillErrorText(toSkillError(e)));
    } finally {
      setBusy(false);
    }
  };

  const onInstall = () => {
    setError(undefined);
    if (status && status.exists && !status.same) {
      setConfirming(true);
      return;
    }
    void install(false);
  };

  const onCopy = async () => {
    try {
      await copy(SKILL_TEXT);
    } catch {
      notify('error', t('skill.copyFailed'));
    }
  };

  const onSaveAs = async () => {
    setError(undefined);
    try {
      const path = await skillSaveAs(invoke);
      if (path !== null) notify('info', t('skill.savedAs', path));
    } catch (e) {
      setError(skillErrorText(toSkillError(e)));
    }
  };

  return (
    <section className="integration-section skill-section">
      <h5>{t('skill.heading')}</h5>
      <div className="integration-field">
        <p className="prompt-hint">{t('skill.hint')}</p>
        {status ? (
          <>
            <p className="prompt-hint">{t('skill.target', status.target)}</p>
            <p role="status" className="mcp-token-state">
              {skillStateText(status)}
            </p>
          </>
        ) : null}
        <div className="mcp-actions">
          <button type="button" disabled={busy} onClick={onInstall}>
            {t('skill.install')}
          </button>
          <button type="button" onClick={() => void onCopy()}>
            {t('skill.copy')}
          </button>
          <button type="button" onClick={() => void onSaveAs()}>
            {t('skill.saveAs')}
          </button>
        </div>
        {confirming && status ? (
          <div className="integration-field">
            <p className="prompt-hint warn">{t('skill.confirmOverwrite', status.target)}</p>
            <div className="mcp-actions">
              <button type="button" className="danger" onClick={() => void install(true)}>
                {t('skill.overwrite')}
              </button>
              <button type="button" onClick={() => setConfirming(false)}>
                {t('skill.cancel')}
              </button>
            </div>
          </div>
        ) : null}
        {error !== undefined ? (
          <p role="alert" className="prompt-hint warn">
            {error}
          </p>
        ) : null}
      </div>
      <div className="integration-field">
        <span className="prompt-question">{t('skill.preview')}</span>
        <pre className="mcp-snippet skill-preview">
          <code>{SKILL_TEXT}</code>
        </pre>
      </div>
    </section>
  );
}
