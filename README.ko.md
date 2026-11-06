# labnoteO Desktop

**labnoteO 연구노트를 설치 파일 하나로. Obsidian도, 플러그인도, 따로 할 준비도 필요 없습니다.**

labnoteO Desktop은 생물학·생물정보학 실험용 마크다운 연구노트 [labnoteO](https://github.com/sblabkribb/labnoteo)를
Windows 독립 앱으로 만든 것입니다. 지금 labnoteO를 쓰려면 Obsidian을 설치하고, 커뮤니티 플러그인 BRAT을 깔고,
그것으로 labnoteO를 설치해야 합니다. 이 앱은 그 과정을 설치 파일 하나로 바꿉니다. 노트는 그대로 내 PC 폴더의
`.labnote.md` 평문 파일이라, 같은 폴더를 Obsidian에서 열어도 그대로 보입니다.

[English](README.md) · **한국어**

[기능](#기능) · [설치](#설치) · [소스에서 빌드](#소스에서-빌드) · [로드맵](#로드맵) · [Apache-2.0 라이선스](LICENSE)

> **초기 미리보기(0.1.0).** 아래에 보이는 연구노트 기본 기능은 지금 동작합니다. labnoteO의 나머지 기능
> (샘플, 워크플로, PartBank, bfworkflow, LLM 보조)은 옮기는 중입니다. [로드맵](#로드맵)을 보세요.

## 기능

아래 GIF는 데모 보관함을 연결한 앱 화면을 그대로 녹화한 것입니다.

### 설치 하나로 시작

처음 실행하면 새 보관함을 만들거나 노트가 있는 폴더를 엽니다. 한 번 정하면 다음부터는 바로 열립니다.
기존 Obsidian 보관함도 그대로 열 수 있고, `.obsidian` 폴더는 건드리지 않습니다.

![처음 실행에서 새 보관함을 만들고 노트 목록으로 들어가기](docs/images/ko/labnoteo-start.gif)

### 마크다운 실험 노트 편집

헤딩, 강조, 목록, 표, 코드 블록, `[[위키링크]]`가 구문 강조되는 마크다운 편집기입니다. 편집은 자동으로
저장됩니다. 편집하는 동안 디스크의 노트가 바뀌면(동기화 등) 덮어쓰기 전에 물어보고, 어느 쪽 내용도 말없이
버리지 않습니다.

![실험 노트를 열어 결과 행을 추가하고 자동 저장되는 모습](docs/images/ko/labnoteo-editor.gif)

### 보관함 전체 검색

모든 노트의 본문을 로컬 SQLite 색인으로 검색합니다. 단어 중간도 찾으므로 "형질전환을", "카나마이신이"처럼
조사가 붙은 한국어도 잘 찾습니다.

![카나마이신을 검색해 해당 실험 노트를 여는 모습](docs/images/ko/labnoteo-search.gif)

### 새 노트를 한 번에

이름을 적고 바로 씁니다. 노트 목록은 디스크의 변화를 따라가므로, 앱 밖에서 만들거나 이름을 바꾸거나 지운
파일도 반영됩니다.

![새 노트를 만들어 목록에 나타나고 바로 작성하는 모습](docs/images/ko/labnoteo-newnote.gif)

### 밝게 · 어둡게 · 한국어 · English

밝은 테마와 어두운 테마 중에 고르거나 Windows 설정을 따릅니다. 화면 언어는 언제든 한국어와 영어 사이에서
바꿀 수 있고, 바로 적용되며 저장하지 않은 편집도 그대로 남습니다.

![어두운 테마로 바꿨다가 다시 밝게, 그리고 화면 언어를 바꾸는 모습](docs/images/ko/labnoteo-settings.gif)

## 설치

Windows 10 또는 11 (64비트).

설치 파일은 [Releases](https://github.com/sblabkribb/labnoteo-desktop/releases) 페이지에 올라갑니다.
**아직 공개된 릴리스는 없습니다.** 그때까지는 [소스에서 빌드](#소스에서-빌드)하세요.

- 설치 파일에 코드 서명이 없어 처음 설치할 때 Windows SmartScreen 경고가 뜹니다.
  **추가 정보 → 실행**을 누르세요.
- 릴리스가 공개되면, 설치된 앱은 새 릴리스로 스스로 업데이트합니다.

## 소스에서 빌드

준비물: [Node.js](https://nodejs.org/) 22, [Rust](https://rustup.rs/) stable 툴체인,
Microsoft C++ Build Tools, WebView2(Windows 11에는 이미 들어 있음).
[Tauri 준비물](https://tauri.app/start/prerequisites/) 문서를 참고하세요.

```powershell
git clone --recursive https://github.com/sblabkribb/labnoteo-desktop.git
cd labnoteo-desktop/app
npm ci
npm test
npm run tauri:build
```

설치 파일은 `app/src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/` 에 만들어집니다.
개발할 때는 `npm run tauri dev` 를 실행합니다.

labnoteO 코어(`@labnoteo/core`)는 `app/vendor/labnoteo` 에 git 서브모듈로 들어 있어, 앱과 Obsidian 플러그인이
같은 노트 로직을 함께 씁니다.

## 로드맵

labnoteO Desktop은 labnoteO의 기능을 모두 옮겨, 누구도 Obsidian 없이 쓸 수 있게 하는 것을 목표로 합니다.

| 영역 | 상태 |
|---|---|
| 보관함, 노트 목록, 마크다운 편집기, 자동 저장, 전체 검색, 테마, 한국어/영어 | 사용 가능 |
| 편집기: 라이브 프리뷰, 위키링크 자동완성·이동, 백링크, 아웃라인 | 다음 차례 |
| 샘플: `@` 자동완성, 샘플 보기, 실험 샘플 표 | 예정 |
| 워크플로·유닛 오퍼레이션, 체크리스트, CSV 내보내기 | 예정 |
| PartBank 연동: 부품 검색, 보관 위치, 사용처 보고 | 예정 |
| 노트 ID, QR 워크시트, 스캔 가져오기 | 예정 |
| [bfworkflow](https://github.com/sblabkribb/bfworkflow) 연동: 카탈로그 동기화, 설계에서 노트 만들기 | 예정 |
| LLM 보조(로컬 모델을 포함한 OpenAI 호환 엔드포인트)와 MCP 서버 | 예정 |
| 연구 저장소용 git 자동화 | 예정 |

API 키(PartBank, bfworkflow, LLM)는 보관함이 아니라 Windows 자격 증명 저장소에 보관합니다.

## 라이선스

[Apache License 2.0](LICENSE).
