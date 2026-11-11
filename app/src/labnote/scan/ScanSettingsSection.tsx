import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { SCAN_EMBED_WIDTH_RANGE, SCAN_IMAGE_EDGE_RANGE } from '../../../vendor/labnoteo/src/settings';
import { t } from '../../i18n/t';
import type { IntegrationDeps, IntegrationSettingsValue } from '../../integrations/IntegrationSettingsDialog';
import { KeyField } from '../../integrations/KeyField';
import { toNetError, type InvokeFn, type SecretStatus } from '../../integrations/netIpc';
import { notifySecretsChange } from '../../integrations/secretsEvents';
import { isComposing } from '../host/DialogFrame';
import { coreT, overrideOr } from '../i18n';
import { commitRangedNumber, connectSlack, folderStateLine, slackStatusLine } from '../port/scanSettings';
import { RECOMMENDED_SCOPE, REQUIRED_SCOPES, type SlackInbox, type SlackMode } from '../port/slackInbox';
import { readSlackLink, scanFolderChoose, scanFolderClear, scanFolderSetMode, scanFolderStatus, type ScanFolderStatus, type ScanMode, type SlackLink } from './scanIpc';
import { scanFeature } from './scanFeature';
import { SelectField } from '../../ui/SelectField';

/** What the section uses of the open vault's scan feature (scanFeature()). */
export interface ScanSettingsFeature {
  watcher: { restart(): void };
  slack: Pick<SlackInbox, 'verify' | 'beginLink' | 'disconnect' | 'start' | 'lastError'>;
  processFolderNow(includeExisting?: boolean): Promise<void>;
  openUnmatched(): Promise<void>;
  unmatchedCount(): Promise<number>;
}

const NO_FOLDER: ScanFolderStatus = { path: null, mode: 'dedicated', exists: false, insideVault: false, since: null, baseline: null };

/** Every scope the app may ask for, each once, in the plugin's order. */
const ALL_SCOPES = [...new Set([...REQUIRED_SCOPES.dm, ...REQUIRED_SCOPES.channel, RECOMMENDED_SCOPE])].join(', ');

type NumberKey = 'scanMaxImageEdge' | 'scanEmbedWidth';

/**
 * The "Barcode & scans" section of the integration settings (plugin scanSettings.ts, logic in port/scanSettings.ts):
 * paper size, the Rust-held scan folder (Choose / Clear, never a typed path), its mode, Process now, the unmatched
 * queue, the stored image size, quality and width, and the Slack inbox. The Slack token is a KeyField (keychain only);
 * the link state is the only thing Connect and Disconnect write. Buttons that open another dialog (Process now, Assign
 * unmatched scans) close the settings first through `onLeave`, so that dialog is not queued behind this one.
 */
export function ScanSettingsSection(props: {
  deps: IntegrationDeps;
  invoke?: InvokeFn;
  /** Default: scanFeature() of the open vault. */
  feature?: ScanSettingsFeature;
  /** Close the settings (after saving what is being edited). */
  onLeave?: () => Promise<void> | void;
  /** Hands over a commit for fields still being edited, run when the settings close (plugin ctx.onHide). */
  onHide?: (commit: () => Promise<void>) => void;
  /** The dialog's key status; without it the section reads its own. */
  secrets?: SecretStatus;
  /** A key status the section read after saving the token. */
  onSecrets?: (status: SecretStatus) => void;
}) {
  const { deps } = props;
  const invoke = props.invoke ?? tauriInvoke;
  const feature: ScanSettingsFeature | undefined = props.feature ?? scanFeature();
  const id = useId();
  const valRef = useRef<IntegrationSettingsValue>(deps.value());
  const [val, setVal] = useState(valRef.current);
  const draftRef = useRef<Record<NumberKey, string>>({
    scanMaxImageEdge: String(val.scanMaxImageEdge),
    scanEmbedWidth: String(val.scanEmbedWidth),
  });
  const [draft, setDraftState] = useState(draftRef.current);
  const [numberNotice, setNumberNotice] = useState<Partial<Record<NumberKey, string>>>({});
  const [folder, setFolder] = useState<ScanFolderStatus>(NO_FOLDER);
  const [folderError, setFolderError] = useState<string | undefined>(undefined);
  const [unmatched, setUnmatched] = useState<number | undefined>(undefined);
  const [link, setLink] = useState<SlackLink | undefined>(undefined);
  const [ownSecrets, setOwnSecrets] = useState<SecretStatus | undefined>(undefined);
  const secrets = props.secrets ?? ownSecrets;
  const setSecrets = (s: SecretStatus) => {
    setOwnSecrets(s);
    props.onSecrets?.(s);
  };
  const [slackMode, setSlackMode] = useState<SlackMode>('dm');
  const [channelInput, setChannelInput] = useState('');
  const [slackNotices, setSlackNotices] = useState<string[]>([]);
  const [connecting, setConnecting] = useState(false);
  const keyRef = useRef<HTMLInputElement>(null);
  const live = useRef(true);

  useEffect(() => {
    live.current = true;
    scanFolderStatus(invoke).then(
      (s) => live.current && setFolder(s),
      () => undefined,
    );
    readSlackLink(invoke).then(
      (l) => live.current && setLink(l),
      () => undefined,
    );
    if (!props.secrets) {
      deps.status().then(
        (s) => live.current && setOwnSecrets(s),
        () => undefined,
      );
    }
    feature?.unmatchedCount().then(
      (n) => live.current && setUnmatched(n),
      () => undefined,
    );
    return () => {
      live.current = false;
    };
    // Read once per mount: the section is redrawn with the dialog.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = async (patch: Partial<IntegrationSettingsValue>) => {
    valRef.current = { ...valRef.current, ...patch };
    setVal(valRef.current);
    try {
      await deps.commit(patch);
    } catch {
      // The app's settings save reports its own failure; the dialog stays open.
    }
  };

  // ── number fields (plugin numberField, #321) ──
  const numberSpec = (key: NumberKey) =>
    key === 'scanMaxImageEdge'
      ? {
          label: coreT('Stored scan size'),
          range: SCAN_IMAGE_EDGE_RANGE,
          allowed: `${SCAN_IMAGE_EDGE_RANGE.min}–${SCAN_IMAGE_EDGE_RANGE.max}`,
          also: undefined,
        }
      : {
          label: coreT('Scan width in notes'),
          range: SCAN_EMBED_WIDTH_RANGE,
          allowed: coreT('0 or {0}–{1}', String(SCAN_EMBED_WIDTH_RANGE.min), String(SCAN_EMBED_WIDTH_RANGE.max)),
          also: [0],
        };

  const setDraft = (key: NumberKey, v: string) => {
    draftRef.current = { ...draftRef.current, [key]: v };
    setDraftState(draftRef.current);
  };

  const commitNumber = async (key: NumberKey) => {
    const spec = numberSpec(key);
    const current = valRef.current[key];
    const r = commitRangedNumber(coreT, { ...spec, current, value: draftRef.current[key] });
    if (live.current) {
      setNumberNotice((n) => ({ ...n, [key]: r.notice }));
      setDraft(key, String(r.value));
    }
    if (r.value !== current) await save({ [key]: r.value });
  };

  const commitNumbers = async () => {
    await commitNumber('scanMaxImageEdge');
    await commitNumber('scanEmbedWidth');
  };
  useEffect(() => {
    props.onHide?.(commitNumbers);
    // Handed over once: commitNumbers reads refs only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onNumberKey = (key: NumberKey) => (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter' || isComposing(e)) return;
    e.preventDefault();
    void commitNumber(key);
  };

  // ── scan folder (B4: Rust picks and holds it) ──
  const afterFolderChange = async () => {
    try {
      const s = await scanFolderStatus(invoke);
      if (live.current) setFolder(s);
    } catch {
      // The row keeps what it showed.
    }
    feature?.watcher.restart();
  };

  const choose = async () => {
    setFolderError(undefined);
    try {
      const s = await scanFolderChoose(invoke);
      if (live.current) setFolder(s);
      feature?.watcher.restart();
    } catch (e) {
      const err = toNetError(e);
      if (!live.current) return;
      setFolderError(
        err.kind === 'badInput' && /vault folder itself/.test(err.message)
          ? t('scan.vaultRootRefused')
          : coreT('Command failed: {0}', err.kind),
      );
    }
  };

  const clear = async () => {
    setFolderError(undefined);
    try {
      await scanFolderClear(invoke);
    } catch (e) {
      if (live.current) setFolderError(coreT('Command failed: {0}', toNetError(e).kind));
      return;
    }
    await afterFolderChange();
  };

  const setMode = async (mode: ScanMode) => {
    setFolderError(undefined);
    try {
      await scanFolderSetMode(mode, invoke);
    } catch (e) {
      if (live.current) setFolderError(coreT('Command failed: {0}', toNetError(e).kind));
      return;
    }
    await afterFolderChange();
  };

  const leaveThen = async (run: () => Promise<void>) => {
    await props.onLeave?.();
    await run();
  };

  // ── Slack ──
  const refreshSecrets = async (): Promise<SecretStatus | undefined> => {
    try {
      const s = await deps.status();
      if (live.current) setSecrets(s);
      return s;
    } catch {
      return undefined;
    }
  };

  const refreshLink = async () => {
    try {
      const l = await readSlackLink(invoke);
      if (live.current) setLink(l);
    } catch {
      // The row keeps what it showed.
    }
  };

  const connect = async () => {
    if (!feature || connecting) return;
    setConnecting(true);
    setSlackNotices([]);
    try {
      // A token typed but not saved yet goes to the keychain first; Rust refuses one that is not xoxb-.
      const typed = keyRef.current?.value.trim() ?? '';
      if (typed) {
        if (!/^xoxb-/.test(typed)) {
          setSlackNotices([coreT('Enter the bot token (it starts with xoxb-).')]);
          return;
        }
        try {
          await deps.setSecret('slackBot', typed);
        } catch {
          setSlackNotices([t('integrations.keyFailed')]);
          return;
        } finally {
          if (keyRef.current) keyRef.current.value = '';
        }
        const s = await refreshSecrets();
        if (s) notifySecretsChange(s);
      }
      const tokenSet = (await refreshSecrets())?.set.slackBot ?? false;
      const r = await connectSlack(coreT, feature.slack, { tokenSet, mode: slackMode, channelInput });
      if (!live.current) return;
      setSlackNotices(r.notices);
      if (r.linked) await refreshLink();
    } finally {
      if (live.current) setConnecting(false);
    }
  };

  const disconnect = async () => {
    if (!feature) return;
    try {
      await feature.slack.disconnect();
    } catch (e) {
      if (live.current) setSlackNotices([coreT('Command failed: {0}', toNetError(e).kind)]);
      return;
    }
    await refreshLink();
    const s = await refreshSecrets();
    if (live.current) setSlackNotices(s?.set.slackBot ? [t('scan.slackTokenKept')] : []);
  };

  const state = folderStateLine(coreT, folder);
  const linked = Boolean(link?.enabled);

  return (
    <>
      <section className="integration-section scan-settings">
        <h5>{coreT('Barcode & scans')}</h5>
        <div className="integration-field">
          <label className="prompt-question" htmlFor={`${id}-paper`}>
            {coreT('Worksheet paper size')}
          </label>
          <SelectField
            id={`${id}-paper`}
            value={val.worksheetPaperSize}
            onChange={(e) => void save({ worksheetPaperSize: e.target.value as IntegrationSettingsValue['worksheetPaperSize'] })}
          >
            <option value="a4">A4</option>
            <option value="letter">Letter</option>
          </SelectField>
        </div>

        <div className="integration-field">
          <span className="prompt-question">{coreT('Scan folder')}</span>
          <p className="prompt-hint">
            {coreT(
              'A folder on this PC where photos and scans arrive (Google Drive folder, scanner share, KakaoTalk downloads…). Checked every 30 seconds. Stored for this PC only; set it on one PC.',
            )}
          </p>
          <div className="scan-folder-row">
            {folder.path ? <code className="scan-folder-path">{folder.path}</code> : null}
            <button type="button" onClick={() => void choose()}>
              {t('scan.chooseFolder')}
            </button>
            {folder.path ? (
              <button type="button" onClick={() => void clear()}>
                {t('scan.clearFolder')}
              </button>
            ) : null}
          </div>
          {state ? <p className={state.warn ? 'prompt-hint warn' : 'prompt-hint'}>{state.text}</p> : null}
          {folderError ? (
            <p role="alert" className="prompt-hint warn">
              {folderError}
            </p>
          ) : null}
        </div>

        <div className="integration-field">
          <label className="prompt-question" htmlFor={`${id}-mode`}>
            {coreT('Scan folder mode')}
          </label>
          <p className="prompt-hint">
            {coreT(
              'Dedicated: a folder only for scans; originals are moved to labnote-processed/ or labnote-failed/ inside it. Shared: a folder with other files too (KakaoTalk, camera uploads); originals stay, files without a worksheet QR code are left alone.',
            )}
          </p>
          <SelectField
            id={`${id}-mode`}
            value={folder.mode}
            disabled={!folder.path}
            onChange={(e) => void setMode(e.target.value as ScanMode)}
          >
            <option value="dedicated" disabled={folder.insideVault}>
              {coreT('Dedicated folder')}
            </option>
            <option value="shared">{coreT('Shared folder')}</option>
          </SelectField>
        </div>

        <div className="integration-field">
          <span className="prompt-question">{coreT('Process scan folder now')}</span>
          <p className="prompt-hint">{coreT('Files already in the folder when it was set are skipped; process them once with the second button.')}</p>
          <div className="scan-folder-row">
            <button type="button" disabled={!feature} onClick={() => void leaveThen(() => feature!.processFolderNow(false))}>
              {coreT('Process now')}
            </button>
            <button type="button" disabled={!feature} onClick={() => void leaveThen(() => feature!.processFolderNow(true))}>
              {coreT('Process existing files too')}
            </button>
          </div>
        </div>

        <div className="integration-field">
          <span className="prompt-question">{coreT('Unmatched scans')}</span>
          {unmatched !== undefined ? (
            <p className="prompt-hint">
              {unmatched > 0 ? coreT('{0} page(s) wait to be assigned to a note.', String(unmatched)) : coreT('No unmatched scans.')}
            </p>
          ) : null}
          <div className="scan-folder-row">
            <button type="button" disabled={!feature} onClick={() => void leaveThen(() => feature!.openUnmatched())}>
              {coreT('Assign unmatched scans')}
            </button>
          </div>
        </div>

        <div className="integration-field">
          <label className="prompt-question" htmlFor={`${id}-edge`}>
            {coreT('Stored scan size')}
          </label>
          <p className="prompt-hint">
            {coreT(
              'Long edge in pixels that a scanned page is scaled down to before it is stored ({0}–{1}).',
              String(SCAN_IMAGE_EDGE_RANGE.min),
              String(SCAN_IMAGE_EDGE_RANGE.max),
            )}
          </p>
          <input
            id={`${id}-edge`}
            type="number"
            className="scan-number"
            value={draft.scanMaxImageEdge}
            onChange={(e) => setDraft('scanMaxImageEdge', e.target.value)}
            onBlur={() => void commitNumber('scanMaxImageEdge')}
            onKeyDown={onNumberKey('scanMaxImageEdge')}
          />
          {numberNotice.scanMaxImageEdge ? (
            <p role="alert" className="prompt-hint warn">
              {numberNotice.scanMaxImageEdge}
            </p>
          ) : null}
        </div>

        <div className="integration-field">
          <label className="prompt-question" htmlFor={`${id}-quality`}>
            {coreT('Stored scan quality')}
          </label>
          <p className="prompt-hint">{coreT('JPEG quality of stored scans. Lower makes smaller files.')}</p>
          <div className="scan-quality">
            <input
              id={`${id}-quality`}
              type="range"
              min="0.5"
              max="1"
              step="0.05"
              value={val.scanJpegQuality}
              onChange={(e) => void save({ scanJpegQuality: Math.round(Number(e.target.value) * 100) / 100 })}
            />
            <output htmlFor={`${id}-quality`}>{Math.round(val.scanJpegQuality * 100)}</output>
          </div>
        </div>

        <div className="integration-field">
          <label className="prompt-question" htmlFor={`${id}-width`}>
            {coreT('Scan width in notes')}
          </label>
          <p className="prompt-hint">
            {coreT(
              'Width in pixels of scans shown in notes ({0}–{1}); 0 shows them full size. Scans already filed keep their size.',
              String(SCAN_EMBED_WIDTH_RANGE.min),
              String(SCAN_EMBED_WIDTH_RANGE.max),
            )}
          </p>
          <input
            id={`${id}-width`}
            type="number"
            className="scan-number"
            value={draft.scanEmbedWidth}
            onChange={(e) => setDraft('scanEmbedWidth', e.target.value)}
            onBlur={() => void commitNumber('scanEmbedWidth')}
            onKeyDown={onNumberKey('scanEmbedWidth')}
          />
          {numberNotice.scanEmbedWidth ? (
            <p role="alert" className="prompt-hint warn">
              {numberNotice.scanEmbedWidth}
            </p>
          ) : null}
        </div>
      </section>

      <section className="integration-section scan-settings">
        <h5>{coreT('Slack scans (optional)')}</h5>
        {linked && link ? (
          <div className="integration-field">
            <span className="prompt-question">{coreT('Slack connection')}</span>
            <p className="prompt-hint">{slackStatusLine(coreT, link, feature?.slack.lastError)}</p>
            <div className="scan-folder-row">
              <button type="button" className="danger" disabled={!feature} onClick={() => void disconnect()}>
                {coreT('Disconnect')}
              </button>
            </div>
          </div>
        ) : (
          <>
            <KeyField
              deps={deps}
              slot="slackBot"
              label={coreT('Slack bot token')}
              hints={[overrideOr('scan.slackTokenHelp', ALL_SCOPES), t('scan.tokenPerUser')]}
              isSet={secrets?.set.slackBot ?? false}
              placeholder="xoxb-…"
              inputRef={keyRef}
              onSaved={(s) => {
                if (s && live.current) setSecrets(s);
              }}
            />
            <div className="integration-field">
              <label className="prompt-question" htmlFor={`${id}-slackmode`}>
                {coreT('Where you send scans')}
              </label>
              <SelectField id={`${id}-slackmode`} value={slackMode} onChange={(e) => setSlackMode(e.target.value as SlackMode)}>
                <option value="dm">{coreT('Direct message to the bot')}</option>
                <option value="channel">{coreT('Private channel')}</option>
              </SelectField>
              {slackMode === 'channel' ? (
                <input
                  type="text"
                  aria-label={coreT('Channel ID (C…) or link')}
                  placeholder={coreT('Channel ID (C…) or link')}
                  autoComplete="off"
                  spellCheck={false}
                  value={channelInput}
                  onChange={(e) => setChannelInput(e.target.value)}
                />
              ) : null}
            </div>
            <div className="scan-folder-row">
              <button type="button" className="primary" disabled={!feature || connecting} onClick={() => void connect()}>
                {coreT('Connect')}
              </button>
            </div>
          </>
        )}
        {slackNotices.map((n, i) => (
          <p key={`notice-${i}`} role="status" className="prompt-hint">
            {n}
          </p>
        ))}
        <details className="scan-howto">
          <summary>{t('scan.slackHowToTitle')}</summary>
          <p className="prompt-hint">
            {t('scan.slackHowTo', REQUIRED_SCOPES.dm.join(', '), REQUIRED_SCOPES.channel.join(', '), RECOMMENDED_SCOPE)}
          </p>
        </details>
      </section>
    </>
  );
}
