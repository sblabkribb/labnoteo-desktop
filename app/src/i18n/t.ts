// UI 문자열 이음새. 모든 화면 문자열은 이 함수를 거친다 (리터럴 직접 기재 금지).
const ko: Record<string, string> = {
  'app.title': 'labnoteO',
  'app.ready': '보관함 셸이 준비되었습니다',
  'firstRun.title': '노트를 둘 곳을 정하세요',
  'firstRun.hint': '노트는 이 컴퓨터의 폴더에 .labnote.md 파일로 저장됩니다. 한 번 정하면 다음부터 바로 열립니다.',
  'firstRun.create': '새 보관함 만들기',
  'firstRun.createHint': '저장 창에서 위치를 고르고 새 폴더 이름을 적으세요.',
  'firstRun.createDialogTitle': '새 보관함 폴더 만들기',
  'firstRun.open': '기존 폴더 열기',
  'firstRun.openHint': '노트가 있는 폴더나 Obsidian 보관함을 그대로 엽니다. .obsidian 은 건드리지 않습니다.',
  'firstRun.openDialogTitle': '보관함 폴더 선택',
  'update.available': '새 버전 {0} 을(를) 쓸 수 있습니다.',
  'update.install': '지금 업데이트',
  'update.installing': '업데이트를 설치하는 중입니다. 앱이 다시 시작됩니다.',
  'update.unsaved': '저장하지 못한 편집이 있어 업데이트를 미뤘습니다. 먼저 저장해 주세요.',
  'update.error': '업데이트하지 못했습니다. 계속되면 최신 설치 파일을 내려받아 다시 설치해 주세요.',
  'vault.loading': '보관함을 불러오는 중',
  'vault.open': '보관함: {0}',
  'vault.change': '보관함 바꾸기',
  'vault.obsidian': 'Obsidian 설정이 있는 폴더입니다. .obsidian 은 건드리지 않습니다.',
  'vault.error.missing': '폴더를 찾을 수 없습니다. 다시 선택해 주세요.',
  'vault.error.generic': '이 폴더를 열 수 없습니다. 폴더가 맞는지 확인해 주세요.',
  'tree.label': '노트',
  'tree.empty': '노트가 없습니다',
  'tree.error': '노트 목록을 불러올 수 없습니다.',
  'newNote.open': '새 노트',
  'newNote.label': '노트 이름',
  'newNote.create': '만들기',
  'newNote.cancel': '취소',
  'newNote.hint': '노트는 보관함 맨 위에 빈 .labnote.md 파일로 만들어집니다.',
  'newNote.error.empty': '노트 이름을 적어 주세요.',
  'newNote.error.separator': '이름에는 / 나 \\ 를 쓸 수 없습니다. 노트는 보관함 맨 위에 만들어집니다.',
  'newNote.error.invalid': '이 이름은 쓸 수 없습니다. 점(.)으로 시작할 수 없고, : ? * < > | " 문자와 CON, NUL 같은 Windows 예약 이름도 쓸 수 없습니다.',
  'newNote.error.exists': '같은 이름의 노트가 이미 있습니다.',
  'newNote.error.failed': '노트를 만들지 못했습니다. 보관함 폴더에 쓸 수 있는지 확인해 주세요.',
  'newNote.error.unsaved': '저장하지 못한 편집이 있어 새 노트를 만들지 않았습니다.',
  'search.label': '노트 검색',
  'search.placeholder': '노트 내용에서 찾기',
  'search.none': '검색 결과가 없습니다',
  'search.error': '검색할 수 없습니다.',
  'search.truncated': '{0}개 이상 일치합니다. 앞의 {0}개만 보입니다. 더 구체적으로 검색해 보세요.',
  'search.skipped': '읽을 수 없어 색인하지 못한 노트가 {0}개 있습니다. 검색에서 빠질 수 있습니다.',
  'search.indexing': '색인을 만드는 중입니다',
  'editor.label': '노트 편집기',
  'editor.empty': '왼쪽에서 노트를 고르면 여기서 편집합니다.',
  'editor.loading': '노트를 여는 중',
  'editor.loadError': '노트를 열 수 없습니다.',
  'editor.dirty': '저장 안 됨',
  'editor.saveError': '저장하지 못했습니다. 내용은 편집기에 그대로 있습니다.',
  'editor.conflicted': '저장하지 않았습니다: 디스크의 노트가 다릅니다',
  'editor.changed.title': '노트가 밖에서 바뀌었습니다',
  'editor.changed.body': '편집하는 동안 이 노트가 다른 곳에서 바뀌었습니다. 내 내용으로 덮어쓰면 그 변경은 사라집니다.',
  'editor.changed.reload': '다시 불러오기 (내 수정은 버림)',
  'editor.changed.overwrite': '내 내용으로 덮어쓰기',
  'editor.gone.title': '노트가 사라졌습니다',
  'editor.gone.body': '이 노트가 디스크에서 삭제되었거나 이름이 바뀌었습니다. 편집한 내용은 편집기에 남아 있습니다.',
  'editor.gone.recreate': '이 위치에 다시 저장',
  'editor.closeAsk.body': '저장하지 못해 창을 닫지 않았습니다. 지금 닫으면 저장하지 않은 내용이 사라집니다.',
  'editor.closeAsk.discard': '저장하지 않고 닫기',
  'editor.closeAsk.stay': '계속 편집',
  'editor.keep': '그대로 두기',
};

/** `{0}` `{1}` 자리를 인자로 채운다. 인자가 모자라면 자리 표시를 그대로 둔다. */
export function format(template: string, args: Array<string | number | boolean>): string {
  return template.replace(/\{(\d+)\}/g, (m, i: string) => {
    const v = args[Number(i)];
    return v === undefined ? m : String(v);
  });
}

export function t(key: string, ...args: Array<string | number | boolean>): string {
  const template = ko[key];
  return template === undefined ? key : format(template, args);
}
