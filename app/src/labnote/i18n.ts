import { createTranslator, type Translator } from '@labnoteo/core';
import obsidianKo from '../../vendor/labnoteo/src/l10n.ko';
import { getLang } from '../i18n/lang';
import { t } from '../i18n/t';

/**
 * 코어와 옮겨 온 플러그인 코드가 쓰는 번역 다리. 그 문장들은 플러그인의 한국어 목록(l10n.ko.ts)에 있고, 키가 곧
 * 영어 원문이다. 앱 번역 함수(app/src/i18n/t.ts)와 따로 둔다: 키 모양이 다르고, 플러그인 문장을 앱 목록에 베끼지 않는다.
 *
 * 부를 때마다 getLang() 을 읽는다. 언어를 바꿔도 이 번역기를 다시 만들 필요가 없다.
 * src/labnote 에서 coreT / host.t / paletteName 에 글자로 넘기는 키는 obsidianKo 에 있어야 한다(__tests__/koCoverage.test.ts).
 */
/**
 * 앱의 용어 규칙(2026-11-11): 한국어 화면에서도 'Workflow' 와 'Unit Operation' 은 영어로 쓴다. 플러그인 한국어 목록은
 * 워크플로 / 유닛 오퍼레이션(한 곳은 붙여 쓴 유닛오퍼레이션, 한 곳은 단위 공정)이라 쓰므로 템플릿을 미리 바꿔 둔다.
 * 조사는 그대로 맞는다: 워크플로·Workflow 는 모음으로, 유닛 오퍼레이션·단위 공정·Unit Operation 은 받침으로 끝난다.
 * 템플릿만 바꾸고 {0} 에 들어가는 값(노트 제목 등 사용자 글)은 건드리지 않는다. 파일에 쓰는 글이 옛 낱말을 알아봐야
 * 하면 vendorKo(key) 로 플러그인 원문을 함께 본다.
 */
export function koTerms(text: string): string {
  return text.replace(/워크플로/g, 'Workflow').replace(/유닛 ?오퍼레이션|단위 ?공정/g, 'Unit Operation');
}

const appKo: Record<string, string> = Object.fromEntries(
  Object.entries(obsidianKo).map(([key, value]) => [key, koTerms(value)])
);
const koTranslator = createTranslator(appKo);
const enTranslator = createTranslator();

export const coreT: Translator = (key, ...args) => (getLang() === 'ko' ? koTranslator : enTranslator)(key, ...args);

/** 플러그인 한국어 목록의 원문 템플릿(용어를 바꾸기 전). 플러그인이나 예전 앱이 노트에 쓴 글을 알아볼 때만 쓴다. */
export function vendorKo(key: string): string | undefined {
  return Object.hasOwn(obsidianKo, key) ? obsidianKo[key] : undefined;
}

/** createLabnoteStructure / createWorkflowContent / catalogDescriptionFor 에 `{locale}` 로 넘기는 언어. */
export function coreLocale(): 'ko' | 'en' {
  return getLang();
}

/**
 * 앱의 한 가지 말(명세 §7.2): 플러그인 한국어 목록의 '시료' 는 앱 어디서나 '샘플' 이다. 보이는 글에만 쓴다(파일 내용은 그대로).
 */
export function appVocabulary(text: string): string {
  return getLang() === 'ko' ? text.replace(/시료/g, '샘플') : text;
}

/**
 * 명령 팔레트 이름: 지금 언어의 이름 하나('실험 생성' / 'Create experiment'). 예전처럼 영어를 괄호로 붙이지 않는다:
 * 영어 키는 팔레트가 찾기 낱말(keywords)로 따로 넘기므로 어느 언어로 쳐도 찾는다.
 */
export function paletteName(key: string): string {
  return appVocabulary(coreT(key));
}

/**
 * 앱에 없는 기능을 말하는 플러그인 문장 대신 보일 앱 문장의 키(계획의 "App overrides" 표).
 * 옮겨 온 코드는 그 자리에서 플러그인 키로 host 번역을 부르는 대신 앱 키로 overrideOr 를 부르고, 플러그인 키는 주석으로 남긴다.
 */
export type OverrideKey =
  | 'insertDate.metaDateFilled'
  | 'insertDate.noNote'
  | 'issueMarker.noNote'
  // 자동화가 없을 때 논의 표시: 플러그인 문장의 "Setup research automation" 안내를 뺀 것(그 명령은 뒤의 하위 프로젝트)
  | 'discussFlag.flagged'
  // 연동 설정(SP6 Task 13): 키는 보관함이 아니라 Windows 자격 증명 관리자에 있다. 스킴 없는 LLM 주소는 https:// 를 붙인다.
  | 'integrations.partbankIntro'
  | 'integrations.keyKeptHere'
  // 연동 설정의 AI 칸(명세 §10.4): 플러그인 한국어 목록은 '프로바이더' 라고 쓴다. 앱은 어디서나 'AI 제공자'.
  | 'integrations.aiProvider'
  | 'integrations.provider'
  | 'integrations.openaiOnlyHint'
  | 'ai.schemeHint'
  // 플러그인의 'Set up a partbank connection in the plugin settings first.': 앱에서는 연동 설정 대화상자(SP6 Task 16).
  | 'partbank.setupFirst'
  // 플러그인의 'Set the Global sample folder in the plugin settings before downloading a catalog.': 앱에서는 샘플 설정(SP6 Task 21).
  | 'partbank.globalFolderFirst'
  // AI 명령(SP6 Task 31): 플러그인의 'Configure an AI provider in settings first.' 는 앱의 연동 설정을 가리킨다.
  | 'ai.configureFirst'
  // 인쇄가 안 되어 브라우저로 열었을 때: 플러그인 문장의 "Printing from Obsidian did not work…" 대신
  | 'print.openedInBrowser'
  // 스캔 결과의 HEIC·TIFF 안내: 플러그인 문장의 "which Obsidian cannot open" 대신(SP7 B11)
  | 'scan.heicAdvice'
  | 'scan.tiffAdvice'
  // 스캔 폴더가 없을 때: 플러그인 문장의 "Settings → Labnote Assistant → Barcode & scans" 대신 연동 설정(SP7 B11)
  | 'scan.setFolderFirst'
  // Slack 받은 편지함: 플러그인 문장의 "Add the scopes in docs/SCAN.md" 와 "See the Slack section of docs/SCAN.md" 대신(SP7 B11)
  | 'scan.slackMissingScope'
  | 'scan.slackCheckFailed'
  // 바코드와 스캔 설정(SP7 Task 29): 플러그인 문장의 "show up in Obsidian" 과 "See docs/SCAN.md for the steps" 대신(B4, B11)
  | 'scan.insideVault'
  | 'scan.slackTokenHelp'
  // MCP 설정(SP7 Part C): 플러그인 문장은 "allow them in Obsidian", "when Obsidian or the server restarts" 라고 쓴다.
  | 'mcp.enableDesc'
  | 'mcp.tokenDesc';

/** 앱 번역 함수로 번역한 대체 문장. */
export function overrideOr(key: OverrideKey, ...args: unknown[]): string {
  return t(key, ...args.map((a) => (typeof a === 'number' || typeof a === 'boolean' ? a : String(a))));
}
