import { t } from '../i18n/t';
import { llmProbe, type InvokeFn } from '../integrations/netIpc';
import { registerProbe } from '../integrations/probes';
import { coreT } from '../labnote/i18n';
import { describeLlmError } from '../labnote/port/llmError';
import { fromStored, type AppSettings } from '../labnote/settings';

/**
 * 연동 설정의 AI "연결 시험"(Task 28, 플러그인에는 없던 기능). 아직 저장하지 않은 칸의 값(주소, 모델, 적은 키)을
 * `llm_probe` 로 보낸다(D8): Rust 가 모델 목록을 받아 이 모델이 있는지 알려 준다. 실패는 describeLlmError 가
 * 시험한 칸의 값으로 문장을 만든다. Rust 의 원래 글은 보이지 않는다. 서버가 그 모델의 컨텍스트 한도(vLLM `max_model_len`)를
 * 알려 주면 `contextLimit` 로 돌려준다: 대화상자가 컨텍스트 창을 맞춘다. `invoke` 는 테스트용이다.
 */
export function registerLlmProbe(invoke?: InvokeFn): () => void {
  return registerProbe('llm', async (fields) => {
    const provider = fields.provider === 'ollama' ? 'ollama' : 'openai';
    const model = fields.model ?? '';
    try {
      const r = await llmProbe({ provider, endpoint: fields.url, model, apiKey: fields.apiKey }, invoke);
      if (r.modelFound) {
        const limit = r.maxModelLen;
        return {
          ok: true,
          message: t('ai.probeOk', model),
          // The settings dialog fits the context window to it (settings suggestContextWindow).
          ...(typeof limit === 'number' && Number.isInteger(limit) && limit > 0 ? { contextLimit: limit } : {}),
        };
      }
      return { ok: false, message: t('ai.probeNoModel', model, r.models.slice(0, 5).join(', ')) };
    } catch (e) {
      const settings: AppSettings = {
        ...fromStored({}),
        llmProvider: provider,
        llmModel: model,
        ...(provider === 'ollama' ? { llmEndpointOllama: fields.url } : { llmEndpointOpenai: fields.url }),
      };
      return { ok: false, message: describeLlmError(e, settings, coreT) };
    }
  });
}
