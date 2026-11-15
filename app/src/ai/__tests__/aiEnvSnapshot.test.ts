// @vitest-environment jsdom
/**
 * 코어 0.142.0 (#597): 명령이 시작할 때 설정을 얼린다. createAiEnv 가 설정의 사본으로 제공자를 만들고(requestSettings),
 * 그 뒤 설정이 바뀌어도 요청 중인 제공자와 오류 문장은 처음 값을 쓴다.
 */
import { createTestHost } from '../../labnote/__tests__/testHost';
import { createAiEnv } from '../aiEnv';

describe('createAiEnv settings snapshot', () => {
  it('requestSettings is a copy taken when the env is made; a later settings change does not reach it', () => {
    const th = createTestHost({}, { llmProvider: 'ollama', llmModel: 'first' });
    try {
      const env = createAiEnv(th.ctx);
      expect(env.requestSettings).toMatchObject({ llmProvider: 'ollama', llmModel: 'first' });
      expect(env.requestSettings).not.toBe(th.ctx.settings);
      void th.ctx.updateSettings({ llmModel: 'second' });
      expect(env.settings().llmModel).toBe('second');
      expect(env.requestSettings?.llmModel).toBe('first');
      expect(env.provider).not.toBeNull();
    } finally {
      th.cleanup();
    }
  });
});
