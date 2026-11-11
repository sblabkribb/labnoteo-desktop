// Ported from app/vendor/labnoteo/src/llm/llmError.ts:10-92 sha256:9fd7cdebadce8a6d
// labnoteO 0.140.2, Apache-2.0.
// Changes: the CONNECTION_FAILURE and SCHEME_FAILURE regexes over Chromium error text → the NetError kind that Rust reports (integrations/netIpc): offline, timeout and tls take the connection branch; invalidUrl and notConfigured take the scheme branch; redirect → the app key integrations.redirected with the location, because the plugin's requestUrl followed redirects and the app must not (D7); insecure, keychain and tooLarge → the app keys integrations.insecure, integrations.keychain and integrations.tooLarge; keyMissing, forbiddenPath, badInput, notJson, remote and noResult → the app key integrations.badRequest; cancelled → '' (no notice, checked first); a NetError of kind status is read like an LlmHttpError(providerName, status, body). No NetError kind falls through to 'AI request failed: <Rust message>', so NetError.message never reaches the user; only a non-NetError (a JS error) keeps the vendor fallback. The settings path (Settings → Labnote Assistant → AI provider → label) → the app key cmd.integrationSettings → AI provider → label, the last two through the passed translator. the 404 sentence for the OpenAI-compatible provider (no "model" in the body) → the app key ai.notFoundOpenai, because the vendor sentence tells the user to remove /v1 and the app now takes https://host/v1 as https://host (C-R3); Ollama keeps the vendor sentence. LabnoteSettings → AppSettings. The Translator parameter is named translate (as in sampleSettings.ts) so the app catalog test does not take the plugin keys for app keys; t is the app translator. errorDetail is unchanged. App only (real-app check): a NetError of kind timeout no longer takes the connection branch but the app key ai.timeout (the answer did not finish in time; a thinking model streamed reasoning for the whole LLM_TIMEOUT and "Cannot connect" sent the user to the network); ReasoningLoopError (new, thrown by ../../ai/streamAssembler when the reasoning keeps repeating one passage) → the app key ai.reasoningLoop.
import type { Translator } from '@labnoteo/core';
import { t } from '../../i18n/t';
import { NetError } from '../../integrations/netIpc';
import type { AppSettings } from '../settings';

/** An HTTP error response from a provider, with the status and body kept apart. */
export class LlmHttpError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number,
    readonly body: string
  ) {
    super(`${provider} request failed (${status}): ${body}`);
    this.name = 'LlmHttpError';
  }
}

/** The stream stopped because the model's reasoning kept repeating one passage (`ai/streamAssembler`). */
export class ReasoningLoopError extends Error {
  constructor() {
    super('the model kept repeating the same reasoning');
    this.name = 'ReasoningLoopError';
  }
}

const DETAIL_MAX = 160;

/** The `error.message` (OpenAI) or `error` (Ollama) of a JSON body, else the body. */
function errorDetail(body: string): string {
  let detail = body;
  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    const error = parsed?.error;
    if (typeof error === 'string') detail = error;
    else if (error && typeof (error as { message?: unknown }).message === 'string') {
      detail = (error as { message: string }).message;
    }
  } catch {
    // Not JSON: show the body as is.
  }
  detail = detail.replace(/\s+/g, ' ').trim();
  return detail.length > DETAIL_MAX ? `${detail.slice(0, DETAIL_MAX)}…` : detail;
}

export function describeLlmError(err: unknown, settings: AppSettings, translate: Translator): string {
  // A cancel the user asked for needs no notice, whatever the settings say.
  if (err instanceof NetError && err.kind === 'cancelled') return '';

  const ollama = settings.llmProvider === 'ollama';
  const providerName = ollama ? 'Ollama' : 'OpenAI';
  const endpoint = ollama ? settings.llmEndpointOllama : settings.llmEndpointOpenai;
  const setting = (label: string): string =>
    [t('cmd.integrationSettings'), translate('AI provider'), translate(label)].join(' → ');
  const endpointSetting = setting(ollama ? 'Ollama endpoint' : 'OpenAI endpoint');
  if (!endpoint.trim()) {
    return translate(
      'The endpoint is empty. Enter the server address in {0}, e.g. {1}.',
      endpointSetting,
      ollama ? 'http://localhost:11434' : 'https://api.openai.com'
    );
  }

  const http =
    err instanceof LlmHttpError
      ? err
      : err instanceof NetError && err.kind === 'status'
        ? new LlmHttpError(providerName, err.status ?? 0, err.body ?? '')
        : undefined;
  if (http) {
    if (http.status === 401 || http.status === 403) {
      return translate('The API key is missing or wrong. Check {0}.', setting('API key'));
    }
    if (http.status === 404) {
      if (/model/i.test(http.body)) {
        return translate('Model {0} was not found. Check {1}.', settings.llmModel, setting('Model'));
      }
      if (!ollama) return t('ai.notFoundOpenai', endpoint, endpointSetting);
      return translate(
        '{0} has no such address (404). Check {1}: enter only the server address, without a path such as /v1 or /api.',
        endpoint,
        endpointSetting
      );
    }
    return translate('AI request failed: {0}', `${http.status} ${errorDetail(http.body)}`.trim());
  }

  if (err instanceof ReasoningLoopError) return t('ai.reasoningLoop', providerName);

  if (err instanceof NetError) {
    switch (err.kind) {
      case 'invalidUrl':
      case 'notConfigured':
        return translate(
          '{0} is not an http:// or https:// address. Check {1}: write it like {2}.',
          endpoint,
          endpointSetting,
          ollama ? 'http://localhost:11434' : 'https://api.openai.com'
        );
      case 'timeout':
        return t('ai.timeout', providerName, endpoint);
      case 'offline':
      case 'tls':
        return translate(
          'Cannot connect to {0} ({1}). Check that it is running and that {2} is right.',
          providerName,
          endpoint,
          endpointSetting
        );
      case 'redirect':
        return t('integrations.redirected', err.location ?? '');
      case 'insecure':
        return t('integrations.insecure');
      case 'keychain':
        return t('integrations.keychain');
      case 'tooLarge':
        return t('integrations.tooLarge');
      default:
        // keyMissing, forbiddenPath, badInput, notJson, remote and noResult: the app built a request Rust refused.
        return t('integrations.badRequest');
    }
  }

  const message = err instanceof Error ? err.message : String(err);
  return translate('AI request failed: {0}', errorDetail(message));
}
