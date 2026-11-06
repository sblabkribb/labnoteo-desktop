import { createTranslator, type Translator } from '@labnoteo/core';
import obsidianKo from '../../vendor/labnoteo/src/l10n.ko';
import { getLang } from '../i18n/lang';
import { t } from '../i18n/t';
import { bilingualName } from './port/bilingualName';

/**
 * 코어와 옮겨 온 플러그인 코드가 쓰는 번역 다리. 그 문장들은 플러그인의 한국어 목록(l10n.ko.ts)에 있고, 키가 곧
 * 영어 원문이다. 앱 번역 함수(app/src/i18n/t.ts)와 따로 둔다: 키 모양이 다르고, 플러그인 문장을 앱 목록에 베끼지 않는다.
 *
 * 부를 때마다 getLang() 을 읽는다. 언어를 바꿔도 이 번역기를 다시 만들 필요가 없다.
 * src/labnote 에서 coreT / host.t / paletteName 에 글자로 넘기는 키는 obsidianKo 에 있어야 한다(__tests__/koCoverage.test.ts).
 */
const koTranslator = createTranslator(obsidianKo);
const enTranslator = createTranslator();

export const coreT: Translator = (key, ...args) => (getLang() === 'ko' ? koTranslator : enTranslator)(key, ...args);

/** createLabnoteStructure / createWorkflowContent / catalogDescriptionFor 에 `{locale}` 로 넘기는 언어. */
export function coreLocale(): 'ko' | 'en' {
  return getLang();
}

/** 명령 팔레트 이름: 한국어에서는 '실험 생성 (Create experiment)', 영어에서는 'Create experiment'. 어느 언어로 쳐도 찾는다. */
export function paletteName(key: string): string {
  return bilingualName(coreT, key);
}

/**
 * 앱에 없는 기능을 말하는 플러그인 문장 대신 보일 앱 문장의 키(계획의 "App overrides" 표).
 * 옮겨 온 코드는 그 자리에서 플러그인 키로 host 번역을 부르는 대신 앱 키로 overrideOr 를 부르고, 플러그인 키는 주석으로 남긴다.
 */
export type OverrideKey = 'insertDate.metaDateFilled' | 'insertDate.noNote' | 'issueMarker.noNote';

/** 앱 번역 함수로 번역한 대체 문장. */
export function overrideOr(key: OverrideKey, ...args: unknown[]): string {
  return t(key, ...args.map((a) => (typeof a === 'number' || typeof a === 'boolean' ? a : String(a))));
}
