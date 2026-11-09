// Ported from app/vendor/labnoteo/src/llm/llmError.ts:9-19 sha256:bb8e4b66dbd9809e
// labnoteO 0.140.2, Apache-2.0.
// Changes: only LlmHttpError so far, which llmProvider.ts throws for a NetError of kind status (Task 27); describeLlmError and the rest of the file are ported in Task 28.

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
