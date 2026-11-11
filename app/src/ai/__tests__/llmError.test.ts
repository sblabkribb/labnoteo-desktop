/**
 * LLM 오류 문장 포트(vendor tests/plugin/llmError.test.ts). 플러그인은 Chromium 오류 글을 정규식으로 갈랐지만,
 * 앱은 Rust 가 준 NetError 의 kind 로 가른다. Rust 의 원래 글(message)은 어떤 kind 에서도 사용자에게 가지 않는다.
 * 설정 경로는 플러그인의 'Settings → Labnote Assistant → …' 대신 앱의 '연동 설정 → AI provider → …' 이다.
 */
import { describe, expect, it } from 'vitest';
import { probeFor } from '../../integrations/probes';
import { fakeInvoke, netError } from '../../integrations/__tests__/fakeNet';
import { NET_ERROR_KINDS } from '../../integrations/netIpc';
import { setLang } from '../../i18n/lang';
import { t } from '../../i18n/t';
import { coreT } from '../../labnote/i18n';
import { describeLlmError, LlmHttpError } from '../../labnote/port/llmError';
import { fromStored, type AppSettings } from '../../labnote/settings';
import { registerLlmProbe } from '../llmProbe';
import { ReasoningLoopError } from '../streamAssembler';

/** 코어 키를 그대로 돌려주는 번역기(vendor 테스트와 같다): 기대 문장을 영어 원문으로 적을 수 있다. */
const id = (key: string, ...args: Array<string | number | boolean>) =>
  key.replace(/\{(\d)\}/g, (_, i) => String(args[Number(i)]));

const settingsOf = (over: Partial<AppSettings> = {}): AppSettings => ({
  ...fromStored({}),
  llmProvider: 'ollama',
  llmModel: 'llama3.1',
  llmEndpointOllama: 'http://localhost:11434',
  llmEndpointOpenai: 'https://api.openai.com',
  ...over,
});
const settings = settingsOf();
const openai = settingsOf({ llmProvider: 'openai' });

/** 앱의 설정 경로: 앱 키 '연동 설정' 뒤에 코어 키 두 개. */
const path = (label: string) => [t('cmd.integrationSettings'), t('integrations.aiProvider'), label].join(' → ');

describe('describeLlmError', () => {
  it('offline and tls say the AI server cannot be reached and name the address row, never the address (real-server check)', () => {
    expect(describeLlmError(netError('offline'), settings, id)).toBe(t('ai.err.offline', path('Ollama endpoint')));
    expect(describeLlmError(netError('tls'), openai, id)).toBe(t('ai.err.offline', path('OpenAI endpoint')));
  });

  it('a timeout says the answer did not finish in time, not that the server cannot be reached (real-app check)', () => {
    // A thinking model streamed reasoning for the whole LLM_TIMEOUT; "Cannot connect" sent the user to the network.
    const msg = describeLlmError(netError('timeout'), openai, id);
    expect(msg).toBe(t('ai.timeout'));
    expect(msg).not.toContain('Cannot connect');
  });

  it('a reasoning loop the stream stopped gets its own sentence', () => {
    expect(describeLlmError(new ReasoningLoopError(), openai, id)).toBe(t('ai.reasoningLoop'));
  });

  it('says to enter an address when the endpoint is empty', () => {
    expect(describeLlmError(netError('invalidUrl'), settingsOf({ llmEndpointOllama: '' }), id)).toBe(
      t('ai.err.emptyEndpoint', path('Ollama endpoint')),
    );
  });

  it('invalidUrl and notConfigured say how to write the endpoint', () => {
    expect(describeLlmError(netError('invalidUrl'), settingsOf({ llmEndpointOllama: 'htp://localhost:11434' }), id)).toBe(
      t('ai.err.badScheme', path('Ollama endpoint')),
    );
    expect(describeLlmError(netError('notConfigured'), openai, id)).toBe(t('ai.err.badScheme', path('OpenAI endpoint')));
  });

  it('401 and 403 point at the API key row', () => {
    for (const status of [401, 403]) {
      expect(describeLlmError(new LlmHttpError('OpenAI', status, '{}'), openai, id)).toBe(
        `The API key is missing or wrong. Check ${path('API key')}.`,
      );
    }
  });

  it('404 with "model" in the body says the model was not found', () => {
    expect(
      describeLlmError(new LlmHttpError('Ollama', 404, '{"error":"model \\"llama3.1\\" not found, try pulling it first"}'), settings, id),
    ).toBe(`Model llama3.1 was not found. Check ${path('Model')}.`);
  });

  it('other OpenAI 404 says the address works with or without /v1 (app key, C-R3)', () => {
    const s = settingsOf({ llmProvider: 'openai', llmEndpointOpenai: 'https://gw.lab.kr/openai/v1/chat/completions' });
    const msg = describeLlmError(new LlmHttpError('OpenAI', 404, '404 page not found'), s, id);
    expect(msg).toBe(t('ai.notFoundOpenai', path('OpenAI endpoint')));
    expect(msg).toContain('https://host/v1');
    expect(msg).not.toContain('gw.lab.kr');
  });

  it('a NetError status 404 for OpenAI gives the same app sentence', () => {
    const s = settingsOf({ llmProvider: 'openai', llmEndpointOpenai: 'https://gw.example/x' });
    expect(describeLlmError(netError('status', { status: 404, body: 'nope' }), s, id)).toBe(t('ai.notFoundOpenai', path('OpenAI endpoint')));
  });

  it('other Ollama 404 says to enter only the server address', () => {
    const s = settingsOf({ llmEndpointOllama: 'http://localhost:11434/api' });
    expect(describeLlmError(new LlmHttpError('Ollama', 404, '404 page not found'), s, id)).toBe(
      t('ai.err.notFoundOllama', path('Ollama endpoint')),
    );
  });

  it('OpenAI 404 with "model" in the body still says the model was not found', () => {
    expect(describeLlmError(new LlmHttpError('OpenAI', 404, '{"error":{"message":"The model gpt-x does not exist"}}'), openai, id)).toBe(
      `Model llama3.1 was not found. Check ${path('Model')}.`,
    );
  });

  it('shows the status and the JSON error message, cut to length, otherwise', () => {
    const body = JSON.stringify({ error: { message: 'Rate limit reached. '.repeat(20) } });
    const notice = describeLlmError(new LlmHttpError('OpenAI', 429, body), openai, id);
    expect(notice.startsWith('AI request failed: 429 Rate limit reached.')).toBe(true);
    expect(notice.endsWith('…')).toBe(true);
    expect(notice.length).toBeLessThan(200);
    expect(describeLlmError(new LlmHttpError('Ollama', 500, '{"error":"boom"}'), settings, id)).toBe('AI request failed: 500 boom');
  });

  it('status error detail is cut at exactly 160 chars', () => {
    const m = describeLlmError(new LlmHttpError('OpenAI', 500, JSON.stringify({ error: { message: 'x'.repeat(300) } })), settings, coreT);
    expect(m).toContain('x'.repeat(160));
    expect(m).not.toContain('x'.repeat(161));
  });

  it('a NetError of kind status is treated like LlmHttpError', () => {
    expect(describeLlmError(netError('status', { status: 401, body: '{}' }), openai, id)).toBe(
      `The API key is missing or wrong. Check ${path('API key')}.`,
    );
  });

  it('no sentence prints the address or host, calls the server "OpenAI", or uses a settings label the screen does not show (ko)', () => {
    const s = settingsOf({ llmProvider: 'openai', llmEndpointOpenai: 'https://gw.secret-lab.kr/openai/v1' });
    const o = settingsOf({ llmEndpointOllama: 'http://10.1.2.3:11434' });
    setLang('ko');
    try {
      const errors: unknown[] = [
        ...NET_ERROR_KINDS.map((kind) => netError(kind, { location: 'https://gw.secret-lab.kr/elsewhere' })),
        new LlmHttpError('OpenAI', 404, 'nope'),
        new LlmHttpError('OpenAI', 401, '{}'),
        new ReasoningLoopError(),
      ];
      for (const err of errors) {
        for (const conf of [s, o]) {
          const m = describeLlmError(err, conf, coreT);
          expect(m).not.toMatch(/secret-lab|10\.1\.2\.3|11434/);
          expect(m).not.toMatch(/OpenAI(?![- ]?(?:엔드포인트|endpoint|호환|compatible))/);
          expect(m).not.toContain('프로바이더');
        }
      }
      expect(describeLlmError(netError('offline'), s, coreT)).toContain('AI 서버');
      expect(describeLlmError(netError('offline'), s, coreT)).toContain('연동 설정 → AI 제공자 → OpenAI 엔드포인트');
    } finally {
      setLang('en');
    }
  });

  it('keeps the status in the error message itself', () => {
    expect(new LlmHttpError('Ollama', 500, 'x').message).toBe('Ollama request failed (500): x');
  });

  it.each(NET_ERROR_KINDS)('NetError %s never shows the raw Rust message', (kind) => {
    const m = describeLlmError(netError(kind, { location: 'https://gw.example' }), settings, coreT);
    expect(m).not.toContain('raw-rust-text'); // netError puts 'raw-rust-text' in message
    if (kind !== 'cancelled') expect(m).not.toBe('');
  });

  it('a redirect says so without naming the target', () => {
    expect(describeLlmError(netError('redirect', { location: 'https://gw.example' }), settings, coreT)).toBe(
      t('ai.err.redirected', [t('cmd.integrationSettings'), t('integrations.aiProvider'), coreT('Ollama endpoint')].join(' → ')),
    );
  });

  it('insecure, keychain and tooLarge have their own sentences', () => {
    expect(describeLlmError(netError('insecure'), openai, coreT)).toBe(t('integrations.insecure'));
    expect(describeLlmError(netError('keychain'), openai, coreT)).toBe(t('integrations.keychain'));
    expect(describeLlmError(netError('tooLarge'), openai, coreT)).toBe(t('integrations.tooLarge'));
  });

  it.each(['keyMissing', 'forbiddenPath', 'badInput', 'notJson', 'remote', 'noResult'] as const)('%s is an app request fault', (kind) => {
    expect(describeLlmError(netError(kind), openai, coreT)).toBe(t('integrations.badRequest'));
  });

  it('cancelled gives no message', () => {
    expect(describeLlmError(netError('cancelled'), settings, coreT)).toBe('');
  });
});

describe('registerLlmProbe', () => {
  const fields = { url: 'https://gw.example', provider: 'openai', model: 'gpt-x', apiKey: 'typed-key' };

  it('registers the llm probe and removes it again', () => {
    const off = registerLlmProbe(fakeInvoke({}).invoke);
    expect(probeFor('llm')).toBeTypeOf('function');
    off();
    expect(probeFor('llm')).toBeUndefined();
  });

  it('sends the unsaved fields to llm_probe and reports a found model', async () => {
    const f = fakeInvoke({ llm_probe: () => ({ models: ['gpt-x'], modelFound: true }) });
    const off = registerLlmProbe(f.invoke);
    try {
      expect(await probeFor('llm')!(fields)).toEqual({ ok: true, message: t('ai.probeOk', 'gpt-x') });
      expect(f.calls).toEqual([['llm_probe', { provider: 'openai', endpoint: 'https://gw.example', model: 'gpt-x', apiKey: 'typed-key' }]]);
    } finally {
      off();
    }
  });

  it('a found model with a server context limit returns it as contextLimit; junk limits are dropped', async () => {
    const f = fakeInvoke({ llm_probe: () => ({ models: ['gpt-x'], modelFound: true, maxModelLen: 262144 }) });
    const off = registerLlmProbe(f.invoke);
    try {
      expect(await probeFor('llm')!(fields)).toEqual({ ok: true, message: t('ai.probeOk', 'gpt-x'), contextLimit: 262144 });
    } finally {
      off();
    }
    const g = fakeInvoke({ llm_probe: () => ({ models: ['gpt-x'], modelFound: true, maxModelLen: -1 }) });
    const off2 = registerLlmProbe(g.invoke);
    try {
      expect(await probeFor('llm')!(fields)).toEqual({ ok: true, message: t('ai.probeOk', 'gpt-x') });
    } finally {
      off2();
    }
  });

  it('the probe reports a missing model with the available ones', async () => {
    const models = ['a', 'b', 'c', 'd', 'e', 'f'];
    const f = fakeInvoke({ llm_probe: () => ({ models, modelFound: false }) });
    const off = registerLlmProbe(f.invoke);
    try {
      expect(await probeFor('llm')!({ ...fields, provider: 'ollama', apiKey: undefined })).toEqual({
        ok: false,
        message: t('ai.probeNoModel', 'gpt-x', 'a, b, c, d, e'),
      });
      expect(f.calls[0][1]).toMatchObject({ provider: 'ollama', apiKey: null });
    } finally {
      off();
    }
  });

  it('a failed probe is described by describeLlmError for the probed fields', async () => {
    const f = fakeInvoke({
      llm_probe: () => {
        throw { kind: 'offline', message: 'raw-rust-text' };
      },
    });
    const off = registerLlmProbe(f.invoke);
    try {
      const r = await probeFor('llm')!(fields);
      expect(r.ok).toBe(false);
      expect(r.message).toBe(describeLlmError(netError('offline'), settingsOf({ llmProvider: 'openai', llmEndpointOpenai: 'https://gw.example', llmModel: 'gpt-x' }), coreT));
      expect(r.message).not.toContain('gw.example');
      expect(r.message).not.toContain('raw-rust-text');
    } finally {
      off();
    }
  });
});
