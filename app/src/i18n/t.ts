// UI 문자열 이음새. 모든 화면 문자열은 이 함수를 거친다 (리터럴 직접 기재 금지).
const ko: Record<string, string> = {
  'app.title': 'labnoteO',
  'app.ready': '보관함 셸이 준비되었습니다',
  'vault.picker.title': '보관함 선택',
  'vault.picker.hint': '.labnote.md 노트가 들어 있는 폴더를 고르세요. Obsidian 보관함도 그대로 쓸 수 있습니다.',
  'vault.picker.choose': '폴더 선택',
  'vault.picker.dialogTitle': '보관함 폴더 선택',
  'vault.loading': '보관함을 불러오는 중',
  'vault.open': '보관함: {0}',
  'vault.obsidian': 'Obsidian 설정이 있는 폴더입니다. .obsidian 은 건드리지 않습니다.',
  'vault.error.missing': '폴더를 찾을 수 없습니다. 다시 선택해 주세요.',
  'vault.error.generic': '이 폴더를 열 수 없습니다. 폴더가 맞는지 확인해 주세요.',
  'tree.label': '노트',
  'tree.empty': '노트가 없습니다',
  'tree.error': '노트 목록을 불러올 수 없습니다.',
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
  'editor.keep': '그대로 두기',
  'test.greeting': '{0} 에 노트 {1} 개',
};

export function t(key: string, ...args: Array<string | number | boolean>): string {
  const template = ko[key];
  if (template === undefined) return key;
  return template.replace(/\{(\d+)\}/g, (m, i: string) => {
    const v = args[Number(i)];
    return v === undefined ? m : String(v);
  });
}
