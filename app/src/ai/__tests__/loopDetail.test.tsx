// @vitest-environment jsdom
/**
 * 생각 고리의 되풀이된 대목(real-server check, 2026-11-11): 생각을 끄고 다시 보내도 고리로 끝나면 오류가 "반복된 부분 보기"를
 * 보이고, 펼치면 되풀이된 끝 대목(약 240자)과 그 앞의 짧은 대목이 글 그대로 나온다. 키와 서버 호스트는 들어가지 않는다.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setLang } from '../../i18n/lang';
import { t } from '../../i18n/t';
import { ReasoningLoopError } from '../../labnote/port/llmError';
import { fromStored } from '../../labnote/settings';
import { MessageView } from '../../assistant/MessageView';
import { LOOP_BEFORE, LOOP_TAIL, OpenAiAssembler } from '../streamAssembler';
import { loopDetail, redactLoopText } from '../loopDetail';

const settings = { ...fromStored({}), llmProvider: 'openai' as const, llmEndpointOpenai: 'https://gpu7.lab.example:8443/v1', llmModel: 'm' };

beforeEach(() => setLang('en'));
afterEach(cleanup);

describe('the loop error carries the repeated passage', () => {
  it('the tail that repeated and a short stretch before its first repeat', () => {
    const intro = 'Let me plan the section. '.repeat(30);
    const loop = 'I will call get_experiment_context first, then add_section. Wait, I should check the heading again. ';
    const text = intro + loop.repeat(20);
    const a = new OpenAiAssembler();
    let thrown: unknown;
    try {
      for (const piece of text.match(/[\s\S]{1,7}/g)!) a.push(JSON.stringify({ choices: [{ index: 0, delta: { reasoning: piece } }] }));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ReasoningLoopError);
    const err = thrown as ReasoningLoopError;
    expect(err.repeated).toHaveLength(LOOP_TAIL);
    expect(loop.repeat(4)).toContain(err.repeated);
    expect(err.before.length).toBeLessThanOrEqual(LOOP_BEFORE);
    expect(err.before.length).toBeGreaterThan(0);
  });
});

describe('loopDetail', () => {
  it('labels and both passages, plain text', () => {
    const d = loopDetail(new ReasoningLoopError('again and again', 'first thoughts'), settings)!;
    expect(d.label).toBe(t('ai.loopDetail.show'));
    expect(d.label).toBe('Show the repeated part');
    expect(d.text).toBe(`${t('ai.loopDetail.repeated')}\nagain and again\n\n${t('ai.loopDetail.before')}\nfirst thoughts`);
  });

  it('nothing for other errors or a loop without a passage', () => {
    expect(loopDetail(new Error('x'), settings)).toBeUndefined();
    expect(loopDetail(new ReasoningLoopError(), settings)).toBeUndefined();
  });

  it('never shows a key, the AI server host, a link, a host:port or an IP', () => {
    const raw =
      'Use https://gpu7.lab.example:8443/v1/chat with Bearer sk-abcdef1234567890 on gpu7.lab.example, ' +
      'or 10.0.0.12 / localhost:11434; token ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef0123456789 ok.';
    const out = redactLoopText(raw, settings);
    for (const bad of ['gpu7', 'lab.example', 'sk-abc', 'Bearer', '10.0.0.12', '11434', 'ABCDEFGHIJKLMNOP', 'https://']) {
      expect(out).not.toContain(bad);
    }
    expect(out).toContain('[link]');
    expect(out).toContain('[server]');
    expect(out).toContain('[hidden]');
    expect(out).toContain('ok.');
    const d = loopDetail(new ReasoningLoopError(raw, raw), settings)!;
    expect(d.text).not.toContain('gpu7');
  });

  it('Korean labels keep the copy in Korean', () => {
    setLang('ko');
    const d = loopDetail(new ReasoningLoopError('반복', ''), settings)!;
    expect(d.label).toBe('반복된 부분 보기');
    expect(d.text).toBe(`${t('ai.loopDetail.repeated')}\n반복`);
  });
});

describe('the error bubble', () => {
  it('offers the repeated part as a closed disclosure with plain text', () => {
    const text = '<b>not html</b>\nline two';
    render(
      <MessageView
        item={{ id: 'r', role: 'assistant', text: '', sources: [], tainted: false, error: 'looped', errorDetail: { label: 'Show the repeated part', text } }}
      />
    );
    const summary = screen.getByText('Show the repeated part');
    const details = summary.closest('details')!;
    expect(details.open).toBe(false);
    fireEvent.click(summary);
    const pre = details.querySelector('pre')!;
    expect(pre.textContent).toBe(text);
    expect(pre.querySelector('b')).toBeNull();
  });

  it('no disclosure without a detail', () => {
    render(<MessageView item={{ id: 'r', role: 'assistant', text: '', sources: [], tainted: false, error: 'failed' }} />);
    expect(document.querySelector('details')).toBeNull();
  });
});
