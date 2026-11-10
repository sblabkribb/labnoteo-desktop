/**
 * 외부 도구의 확인 글(spec §7.2, §7.4; assistant spec §7.3, plan Task 14): 바깥 내용이 닿은 뒤의 웹 검색은 보낼 검색어를
 * 보이고 묻는다(`webAfterTaint`), 웹에서 온 내용이 닿았으면 웹 줄(`web.tainted`)을 덧붙인다.
 */
import { setLang } from '../../i18n/lang';
import { t } from '../../i18n/t';
import type { ToolCall } from '../../labnote/port/llmProvider';
import { externalApprovalMessage, type ExternalToolMeta } from '../externalTools';

const WEB: ExternalToolMeta = { kind: 'web', serverName: 'web', toolTitle: 'web_search', readOnly: true };
const MCP: ExternalToolMeta = { kind: 'mcp', serverId: 'a', serverName: 'Server A', toolTitle: 'Write A', readOnly: false };
const search = (query: string): ToolCall => ({ id: 'c', name: 'web_search', arguments: { query } });

beforeEach(() => setLang('ko'));

describe('externalApprovalMessage', () => {
  it('webAfterTaint shows why and the exact query', () => {
    const msg = externalApprovalMessage(search('PCR 정제 실험 노트 내용'), WEB, false, { tainted: true, reason: 'webAfterTaint' });
    expect(msg).toContain(t('web.confirm.afterTaint', 'PCR 정제 실험 노트 내용'));
    // Task 22: the web is named in words ("웹의 'web_search'"), not by its kind id ("web의").
    expect(msg).toContain("AI가 웹의 'web_search' 도구를 쓰려고 해요.");
    setLang('en');
    expect(externalApprovalMessage(search('q'), WEB, false, { tainted: true, reason: 'webAfterTaint' })).toContain(
      'The AI wants to use the tool "web_search" on the web.',
    );
    setLang('ko');
    expect(msg).not.toContain(t('ai.confirm.tainted'));
    expect(msg).not.toContain(t('web.tainted'));
  });

  it('the query line is one line without control or bidi characters', () => {
    const msg = externalApprovalMessage(search('a\nb‮c\u0007'), WEB, false, { tainted: true, reason: 'webAfterTaint' });
    expect(msg).toContain(t('web.confirm.afterTaint', 'a bc'));
  });

  it('after a web result the web line is added to a write and to a webAfterTaint search', () => {
    const write = externalApprovalMessage({ id: 'c', name: 'mcp_a_write', arguments: {} }, MCP, true, { tainted: true, web: true });
    expect(write).toContain(t('ai.confirm.tainted'));
    expect(write).toContain(t('web.tainted'));
    const again = externalApprovalMessage(search('q'), WEB, false, { tainted: true, reason: 'webAfterTaint', web: true });
    expect(again).toContain(t('web.tainted'));
  });

  it('without a web source there is no web line', () => {
    const write = externalApprovalMessage({ id: 'c', name: 'mcp_a_write', arguments: {} }, MCP, true, { tainted: true });
    expect(write).toContain(t('ai.confirm.tainted'));
    expect(write).not.toContain(t('web.tainted'));
  });

  it('has Korean and English for the web lines', () => {
    expect(t('web.tainted')).toBe('웹에서 가져온 내용이 이 작업에 영향을 줬을 수 있어요.');
    setLang('en');
    expect(t('web.tainted')).toBe('Web content may have influenced this action.');
    expect(t('web.queryShown', 'pcr')).toBe('Searching the web: pcr');
  });
});
