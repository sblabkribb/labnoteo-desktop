import { useEffect, useId, useRef, useState } from 'react';
import { t } from '../../i18n/t';
import { overrideOr } from '../../labnote/i18n';
import { cleanScholarSources, isContactEmail, type AppSettings, type ScholarSources } from '../../labnote/settings';
import type { IntegrationDeps } from '../IntegrationSettingsDialog';
import { KeyField } from '../KeyField';
import type { SecretStatus } from '../netIpc';

/**
 * "문헌 검색" 묶음(spec §8.4): 출처 스위치 넷(기본 켬), NCBI API 키(쓰기만 하는 `KeyField`, 고정 슬롯 `ncbiEutils`),
 * 연락처 이메일 두 칸. 이메일은 칸을 떠날 때(또는 설정 창을 닫을 때) 모양을 보고 저장한다: 비우면 ''(보내지 않음),
 * 모양이 아니면 저장하지 않고 칸 밑에 알린다. 키 값은 React 상태에 두지 않는다(KeyField).
 */
export type ScholarSettingsValue = Pick<AppSettings, 'scholarSources' | 'ncbiEmail' | 'crossrefMailto'>;
type EmailKey = 'ncbiEmail' | 'crossrefMailto';

const SOURCES: ReadonlyArray<keyof ScholarSources> = ['pubmed', 'europepmc', 'crossref', 'biorxiv'];

function sourceLabel(key: keyof ScholarSources): string {
  switch (key) {
    case 'pubmed':
      return t('scholar.source.pubmed');
    case 'europepmc':
      return t('scholar.source.europepmc');
    case 'crossref':
      return t('scholar.source.crossref');
    default:
      return t('scholar.source.biorxiv');
  }
}

export function ScholarSection(props: {
  value: Partial<ScholarSettingsValue>;
  save(patch: Partial<ScholarSettingsValue>): Promise<boolean | void>;
  deps: Pick<IntegrationDeps, 'setSecret' | 'clearSecret' | 'status'>;
  ncbiKeySet: boolean;
  onSaved(status?: SecretStatus): void;
  /** 설정 창을 닫기 전에 부를 저장(떠나지 않은 이메일 칸). */
  onHide?(commit: () => Promise<void>): void;
}) {
  const id = useId();
  const sources = props.value.scholarSources ?? cleanScholarSources(undefined);
  const sourcesRef = useRef(sources);
  sourcesRef.current = sources;
  const saved = useRef<Record<EmailKey, string>>({ ncbiEmail: props.value.ncbiEmail ?? '', crossrefMailto: props.value.crossrefMailto ?? '' });
  const draftRef = useRef<Record<EmailKey, string>>({ ...saved.current });
  const [draft, setDraftState] = useState(draftRef.current);
  const [invalid, setInvalid] = useState<Partial<Record<EmailKey, boolean>>>({});

  const setDraft = (key: EmailKey, v: string) => {
    draftRef.current = { ...draftRef.current, [key]: v };
    setDraftState(draftRef.current);
    setInvalid((x) => ({ ...x, [key]: false }));
  };

  const commitEmail = async (key: EmailKey) => {
    const v = draftRef.current[key].trim();
    if (v && !isContactEmail(v)) {
      setInvalid((x) => ({ ...x, [key]: true }));
      return;
    }
    if (v !== draftRef.current[key]) setDraft(key, v);
    if (v === saved.current[key]) return;
    saved.current = { ...saved.current, [key]: v };
    await props.save({ [key]: v });
  };

  const commitAll = useRef(async () => undefined as void);
  commitAll.current = async () => {
    await commitEmail('ncbiEmail');
    await commitEmail('crossrefMailto');
  };
  const onHide = props.onHide;
  useEffect(() => {
    onHide?.(() => commitAll.current());
    // 한 번만 맡긴다: 맡긴 함수가 늘 최신 commitAll 을 부른다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggle = (key: keyof ScholarSources, on: boolean) => {
    void props.save({ scholarSources: { ...sourcesRef.current, [key]: on } });
  };

  const emailField = (key: EmailKey, label: string) => (
    <div className="integration-field">
      <label className="prompt-question" htmlFor={`${id}-${key}`}>
        {label}
      </label>
      <input
        id={`${id}-${key}`}
        type="email"
        autoComplete="off"
        spellCheck={false}
        maxLength={254}
        value={draft[key]}
        onChange={(e) => setDraft(key, e.target.value)}
        onBlur={() => void commitEmail(key)}
      />
      {invalid[key] ? (
        <p role="alert" className="prompt-hint warn">
          {t('scholar.emailInvalid')}
        </p>
      ) : null}
    </div>
  );

  return (
    <section className="integration-section">
      <h5>{t('scholar.title')}</h5>
      <p className="prompt-hint">{t('scholar.help')}</p>
      <p className="prompt-hint">{t('scholar.queryNote')}</p>
      {SOURCES.map((key) => (
        <div className="integration-field" key={key}>
          <label className="prompt-question switch-label">
            <input
              type="checkbox"
              role="switch"
              className="switch"
              checked={sources[key]}
              onChange={(e) => toggle(key, e.target.checked)}
            />{' '}
            {sourceLabel(key)}
          </label>
        </div>
      ))}
      <KeyField
        deps={props.deps}
        slot="ncbiEutils"
        label={t('scholar.ncbiKey')}
        hints={[t('scholar.ncbiKeyHint'), overrideOr('integrations.keyKeptHere')]}
        isSet={props.ncbiKeySet}
        onSaved={props.onSaved}
      />
      {emailField('ncbiEmail', t('scholar.ncbiEmail'))}
      {emailField('crossrefMailto', t('scholar.crossrefMailto'))}
      <p className="prompt-hint">{t('scholar.emailHelp')}</p>
    </section>
  );
}
