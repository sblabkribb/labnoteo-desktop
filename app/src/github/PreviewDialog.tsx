import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { t } from '../i18n/t';
import { useLang } from '../i18n/useLang';
import { DialogFrame } from '../labnote/host/DialogFrame';
import type { DialogSpec } from '../labnote/host/dialogStore';
import { Icon } from '../ui/Icon';
import { formatBytes } from '../viewers/viewerStatus';
import type { AllowedHit, Change, Hit, PlanFile, Red, UploadChoices, Yellow } from '../integrations/githubIpc';
import type { PreviewHead, ReadyPlan } from './githubFlow';

/** 미리보기에서 파일을 여는 길(빨간 항목의 [파일 열기]). */
export interface PreviewDeps {
  openFile(path: string): Promise<void> | void;
}

export type PreviewSpec = { kind: 'githubPreview'; plan: ReadyPlan; head: PreviewHead; deps: PreviewDeps };
export type QuickSpec = { kind: 'githubQuick'; plan: ReadyPlan };
export type QuickAnswer = 'upload' | 'details' | 'cancel';

const size = (n: number) => formatBytes(n, t);

function base(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function dir(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

function badge(change: Change): string | null {
  switch (change) {
    case 'new':
      return t('github.preview.badgeNew');
    case 'changed':
      return t('github.preview.badgeChanged');
    case 'deleted':
      return t('github.preview.badgeDeleted');
    case 'same':
      return null;
  }
}

function hitKind(h: Hit): string {
  switch (h.kind) {
    case 'apiKey':
      return t('github.preview.kind.apiKey');
    case 'privateKey':
      return t('github.preview.kind.privateKey');
    case 'password':
      return t('github.preview.kind.password');
    case 'token':
      return t('github.preview.kind.token');
    case 'suspect':
      return t('github.preview.kind.suspect');
    case 'saved':
      return t('github.preview.secretSaved', h.label);
  }
}

/** 확인할 것(노랑) 한 줄: 글과 덧붙일 파일 이름. */
function yellowLines(yellow: readonly Yellow[]): Array<{ text: string; names: string[] }> {
  const out: Array<{ text: string; names: string[] }> = [];
  const large = yellow.filter((y): y is Extract<Yellow, { kind: 'large' }> => y.kind === 'large');
  if (large.length > 0) out.push({ text: t('github.preview.big', large.length), names: large.map((y) => `${base(y.path)} (${size(y.size)})`) });
  const nfd = yellow.filter((y): y is Extract<Yellow, { kind: 'nfd' }> => y.kind === 'nfd');
  if (nfd.length > 0) out.push({ text: t('github.preview.nfd', nfd.length), names: nfd.map((y) => y.path) });
  for (const y of yellow) {
    switch (y.kind) {
      case 'repoLarge':
        out.push({ text: t('github.preview.repoBig'), names: [] });
        break;
      case 'gps':
        out.push({ text: t('github.preview.gps', y.paths.length), names: y.paths });
        break;
      case 'unscanned':
        out.push({ text: t('github.preview.unscanned', y.paths.length), names: y.paths });
        break;
      case 'vaultIsGit':
        out.push({ text: t('github.err.vaultIsGit'), names: [] });
        break;
      case 'excludedLink':
        out.push({ text: t('github.preview.excludedLink'), names: [y.path] });
        break;
      case 'info':
        switch (y.info) {
          case 'author':
            out.push({ text: t('github.preview.author', y.names.join(', ')), names: [] });
            break;
          case 'crossLinks':
            out.push({ text: t('github.preview.crossLinks', y.count), names: [] });
            break;
          case 'wikiLinks':
            out.push({ text: t('github.preview.wikiLinks', y.count), names: [] });
            break;
          case 'outside':
            out.push({ text: t('github.preview.outside', y.count), names: y.paths });
            break;
          case 'unused':
            out.push({ text: t('github.preview.unused', y.count), names: y.paths });
            break;
        }
        break;
      default:
        break;
    }
  }
  return out;
}

/**
 * spec §5.4 화면 C: Rust 가 세운 계획을 보인다. 웹뷰는 파일을 빼거나(체크 해제) 키가 아니라고 확인할 수만 있다:
 * 파일을 더하는 요소는 없다. 빨간 항목이 남아 있는 동안 [올리기] 는 꺼져 있다. 공용 시료는 기본으로 올리지 않는다.
 */
export function PreviewDialog(props: {
  spec: Extract<DialogSpec, { kind: 'githubPreview' }>;
  onDone: (value: UploadChoices) => void;
  onCancel: () => void;
}) {
  useLang();
  const { plan, head, deps } = props.spec;
  const id = useId();
  const [untick, setUntick] = useState<ReadonlySet<string>>(() => new Set());
  const [allowed, setAllowed] = useState<readonly AllowedHit[]>([]);
  const [samples, setSamples] = useState(false);

  const visible = plan.files.filter((f) => !f.sample);
  const groups = useMemo(() => {
    const m = new Map<string, PlanFile[]>();
    for (const f of visible) {
      const key = dir(f.path);
      m.set(key, [...(m.get(key) ?? []), f]);
    }
    return [...m.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan]);
  const tickable = (f: PlanFile) => !f.generated && f.change !== 'deleted';
  const sending = visible.filter((f) => f.change !== 'deleted' && !untick.has(f.path));
  const bytes = sending.reduce((n, f) => n + f.size, 0);

  const toggle = (path: string, on: boolean) =>
    setUntick((before) => {
      const next = new Set(before);
      if (on) next.delete(path);
      else next.add(path);
      return next;
    });
  const isAllowed = (h: Hit) => allowed.some((a) => a.path === h.path && a.lineHash === h.lineHash);

  /** 빨간 항목이 이 고름으로 풀렸는지. 풀 수 없는 것은 언제나 false. */
  const resolved = (r: Red): boolean => {
    switch (r.kind) {
      case 'secret':
        if (r.fromSample) return !samples;
        return untick.has(r.hit.path) || (r.hit.overridable && isAllowed(r.hit));
      case 'tooLarge':
      case 'unreadable':
        return untick.has(r.path);
      case 'uploadTooLarge':
        return bytes <= r.limit;
      case 'nfdCollision':
        return r.paths.filter((p) => !untick.has(p)).length <= 1;
      case 'publicNotConfirmed':
      case 'divergedNotAcknowledged':
        return false;
    }
  };
  const blocking = plan.red.filter((r) => !resolved(r));
  const yellows = yellowLines(plan.yellow);

  const upload = () => {
    if (blocking.length > 0) return;
    const choices: UploadChoices = { untick: [...untick], allowHits: [...allowed], includeSamples: samples };
    props.onDone(choices);
  };

  const redRow = (r: Red, i: number) => {
    const done = resolved(r);
    const cls = done ? 'github-finding done' : 'github-finding';
    switch (r.kind) {
      case 'secret':
        return (
          <li key={i} className={cls}>
            <p>{t('github.preview.secret', base(r.hit.path), r.hit.line, hitKind(r.hit), r.hit.masked)}</p>
            {r.fromSample ? null : (
              <div className="github-actions">
                <button type="button" onClick={() => void Promise.resolve(deps.openFile(r.hit.path)).catch(() => undefined)}>
                  {t('github.preview.openFile')}
                </button>
                <button type="button" disabled={untick.has(r.hit.path)} onClick={() => toggle(r.hit.path, false)}>
                  {t('github.preview.leaveOut')}
                </button>
                {r.hit.overridable ? (
                  <button
                    type="button"
                    className="github-link"
                    disabled={isAllowed(r.hit)}
                    onClick={() => setAllowed((a) => [...a, { path: r.hit.path, lineHash: r.hit.lineHash }])}
                  >
                    {t('github.preview.notAKey')}
                  </button>
                ) : null}
              </div>
            )}
          </li>
        );
      case 'tooLarge':
        return (
          <li key={i} className={cls}>
            <p>
              <code>{base(r.path)}</code> ({size(r.size)}): {t('github.preview.tooBig')}
            </p>
            <div className="github-actions">
              <button type="button" disabled={untick.has(r.path)} onClick={() => toggle(r.path, false)}>
                {t('github.preview.leaveOut')}
              </button>
            </div>
          </li>
        );
      case 'uploadTooLarge':
        return (
          <li key={i} className={cls}>
            <p>{t('github.preview.uploadTooBig')}</p>
          </li>
        );
      case 'nfdCollision':
        return (
          <li key={i} className={cls}>
            <p>{t('github.preview.dropOne')}</p>
            <p className="github-names">{r.paths.join(', ')}</p>
          </li>
        );
      case 'unreadable':
        return (
          <li key={i} className={cls}>
            <p>
              {t('github.preview.unreadable')}: <code>{r.path}</code>
            </p>
            <div className="github-actions">
              <button type="button" disabled={untick.has(r.path)} onClick={() => toggle(r.path, false)}>
                {t('github.preview.leaveOut')}
              </button>
            </div>
          </li>
        );
      case 'publicNotConfirmed':
        return (
          <li key={i} className={cls}>
            <p>{t('github.public.nowPublic')}</p>
          </li>
        );
      case 'divergedNotAcknowledged':
        return (
          <li key={i} className={cls}>
            <p>{t('github.diverged.title')}</p>
            <p className="github-names">{r.paths.join(', ')}</p>
          </li>
        );
    }
  };

  const reason = (r: string) =>
    r === 'hard' ? t('github.preview.excludedAlways') : r === 'tooLarge' ? t('github.preview.tooBig') : r === 'link' ? t('github.preview.excludedLink') : t('github.preview.excludedByYou');

  return (
    <DialogFrame title={t('github.preview.title')} className="github-dialog github-preview" onCancel={props.onCancel}>
      <div className="github-form">
        <p className="github-private">
          <Icon name={head.private === false ? 'globe' : 'lock'} size={14} />
          <span>
            {head.fullName ? <code>{head.fullName}</code> : null} {head.title ? `"${head.title}"` : null}
          </span>
        </p>
        <p className="prompt-hint">{t('github.preview.summary', sending.length, size(bytes), new Set([...plan.excluded.map((x) => x.path), ...untick]).size)}</p>
        <div className="github-files" role="group" aria-label={t('github.preview.title')}>
          {groups.map(([folder, files]) => (
            <fieldset key={folder} className="github-folder">
              <legend>{folder || '/'}</legend>
              {files.map((f) => {
                const b = badge(f.change);
                return (
                  <div key={f.path} className="github-file">
                    {tickable(f) ? (
                      <input
                        id={`${id}-${f.path}`}
                        type="checkbox"
                        checked={!untick.has(f.path)}
                        onChange={(e) => toggle(f.path, e.target.checked)}
                      />
                    ) : (
                      <span className="github-file-pad" />
                    )}
                    <label htmlFor={tickable(f) ? `${id}-${f.path}` : undefined} className="github-file-name">
                      {base(f.path)}
                    </label>
                    <span className="github-file-size">{size(f.size)}</span>
                    {b ? <span className={`github-badge ${f.change}`}>{b}</span> : null}
                  </div>
                );
              })}
            </fieldset>
          ))}
        </div>
        {plan.excluded.length > 0 ? (
          <details className="github-excluded">
            <summary>{t('github.preview.excluded', plan.excluded.length)}</summary>
            <ul>
              {plan.excluded.map((x) => (
                <li key={x.path}>
                  <code>{x.path}</code> — {reason(x.reason)}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
        {plan.red.length > 0 ? (
          <section className="github-red" aria-label={t('github.preview.mustFix')}>
            <h3>
              <Icon name="circle-x" size={14} /> <span>{t('github.preview.mustFix')}</span>
            </h3>
            <ul>{plan.red.map(redRow)}</ul>
          </section>
        ) : null}
        {yellows.length > 0 ? (
          <section className="github-yellow" aria-label={t('github.preview.check')}>
            <h3>
              <Icon name="triangle-alert" size={14} /> <span>{t('github.preview.check')}</span>
            </h3>
            <ul>
              {yellows.map((y, i) => (
                <li key={i} className="github-finding">
                  <p>{y.text}</p>
                  {y.names.length > 0 ? <p className="github-names">{y.names.join(', ')}</p> : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {plan.samples.length > 0 ? (
          <div className="github-samples">
            <label>
              <input type="checkbox" checked={samples} onChange={(e) => setSamples(e.target.checked)} /> {t('github.preview.samples', plan.samples.length)}
            </label>
            <ul>
              {plan.samples.map((s) => (
                <li key={`${s.type}|${s.id}`}>
                  {s.id} ({s.type}
                  {s.name ? `, "${s.name}"` : ''})
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <div className="dialog-actions">
          <button type="button" onClick={props.onCancel}>
            {t('dialog.cancel')}
          </button>
          <button type="button" className="primary" disabled={blocking.length > 0} onClick={upload}>
            {t('github.preview.upload')}
          </button>
        </div>
      </div>
    </DialogFrame>
  );
}

/**
 * 다시 올리기의 짧은 확인(spec §5.4): 새로 올라가는 파일과 GitHub 에서 지워지는 파일을 이름으로 보인다.
 * [올리기] [자세히 보기] [취소].
 */
export function QuickDialog(props: {
  spec: Extract<DialogSpec, { kind: 'githubQuick' }>;
  onDone: (value: QuickAnswer) => void;
  onCancel: () => void;
}) {
  useLang();
  const { plan } = props.spec;
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => first.current?.focus(), []);
  const added = plan.files.filter((f) => f.change === 'new' && !f.generated);
  const gone = plan.files.filter((f) => f.change === 'deleted' && !f.generated);
  return (
    <DialogFrame title={t('github.quick.title', added.length, gone.length)} className="github-dialog github-quick" onCancel={props.onCancel}>
      <div className="github-form">
        {added.length > 0 ? (
          <p>
            <strong>{t('github.preview.badgeNew')}:</strong> {added.map((f) => base(f.path)).join(', ')}
          </p>
        ) : null}
        {gone.length > 0 ? (
          <p>
            <strong>{t('github.preview.badgeDeleted')}:</strong> {gone.map((f) => base(f.path)).join(', ')} ({t('github.quick.historyKept')})
          </p>
        ) : null}
        <div className="dialog-actions">
          <button type="button" onClick={props.onCancel}>
            {t('dialog.cancel')}
          </button>
          <button type="button" onClick={() => props.onDone('details')}>
            {t('github.quick.details')}
          </button>
          <button ref={first} type="button" className="primary" onClick={() => props.onDone('upload')}>
            {t('github.preview.upload')}
          </button>
        </div>
      </div>
    </DialogFrame>
  );
}
