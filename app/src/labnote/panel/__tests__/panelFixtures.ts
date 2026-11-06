/** 실험 README. `fm` 은 front matter 에 더할 줄들, `checklist` 는 Related Workflows 의 항목들. */
export function readme(title: string, status: string, fm = '', checklist = ''): string {
  return [
    '---',
    `title: ${title}`,
    'author: [김연구, 이연구]',
    'project: 단백질',
    `status: ${status}`,
    'last_updated_date: 2026-02-03',
    `${fm}---`,
    '',
    '## 🗂️ Related Workflows',
    '',
    `${checklist}`,
    '## Summary and Discussion',
    '',
  ].join('\n');
}
