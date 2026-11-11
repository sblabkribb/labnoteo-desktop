import { useEffect, useState } from 'react';
import { t } from '../../i18n/t';
import { getMode, setMode, subscribeMode, type EditorMode } from '../../editor/live/mode';
import type { AppSettings, ImageFolder } from '../../labnote/settings';
import { Segmented } from '../Segmented';
import { SettingRow, Toggle } from './SettingRow';

/**
 * 설정 → 편집기: 기본 편집 방식(라이브 미리보기 / 소스 보기, 이 PC 의 저장소 — Ctrl+E 와 같은 값)과
 * 그림 저장 폴더(보관함 설정 imageFolder: 기본 resources, images 는 Obsidian·플러그인과 같다 — 2026-11-10 사용자 결정),
 * AI 초안 표시를 노트에 남기기(보관함 설정 aiDraftNoteInFile: 기본 끔 — 2026-11-11 사용자 결정).
 */
export function EditorPage(props: { settings: AppSettings; update: (patch: Partial<AppSettings>) => Promise<void> }) {
  const [mode, setModeState] = useState<EditorMode>(getMode);
  useEffect(() => subscribeMode(setModeState), []);
  const [folder, setFolder] = useState<ImageFolder>(props.settings.imageFolder);
  const chooseFolder = (next: ImageFolder) => {
    setFolder(next);
    void props.update({ imageFolder: next });
  };
  const [draftNote, setDraftNote] = useState(props.settings.aiDraftNoteInFile);
  const flipDraftNote = (next: boolean) => {
    setDraftNote(next);
    void props.update({ aiDraftNoteInFile: next });
  };
  return (
    <>
      <SettingRow
        label={t('settings.editorMode')}
        description={t('settings.editorMode.desc')}
        control={
          <Segmented<EditorMode>
            label={t('settings.editorMode')}
            value={mode}
            onChange={setMode}
            options={[
              { value: 'live', label: t('editor.mode.live') },
              { value: 'source', label: t('editor.mode.source') },
            ]}
          />
        }
      />
      <SettingRow
        label={t('settings.imageFolder')}
        description={t('settings.imageFolder.desc')}
        control={
          <Segmented<ImageFolder>
            label={t('settings.imageFolder')}
            value={folder}
            onChange={chooseFolder}
            options={[
              { value: 'resources', label: t('settings.imageFolder.resources') },
              { value: 'images', label: t('settings.imageFolder.images') },
            ]}
          />
        }
      />
      <SettingRow
        label={t('settings.aiDraftNote')}
        description={t('settings.aiDraftNote.desc')}
        control={<Toggle label={t('settings.aiDraftNote')} checked={draftNote} onChange={flipDraftNote} />}
      />
    </>
  );
}
