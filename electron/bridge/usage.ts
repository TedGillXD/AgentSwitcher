import { Transform } from 'node:stream';
import type { ApiUsageSample } from '../../shared/types';
import { MAX_SSE_FRAME_LENGTH, parseSseFrame, SSE_FRAME_BREAK } from './sse';

type TokenUsage = Pick<ApiUsageSample, 'inputTokens' | 'outputTokens' | 'cachedInputTokens'>;
export type UsageObserver = (usage: TokenUsage | undefined) => void;

const MAX_OBSERVED_JSON_BYTES = 64 * 1024 * 1024;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function tokens(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function cacheTokens(value: unknown, inputTokens: number): number | undefined {
  const count = tokens(value);
  return count !== undefined && count <= inputTokens ? count : undefined;
}

export function responsesUsage(value: unknown): TokenUsage | undefined {
  if (!object(value) || !object(value.usage)) return undefined;
  const { input_tokens, output_tokens, input_tokens_details } = value.usage;
  const inputTokens = tokens(input_tokens);
  const outputTokens = tokens(output_tokens);
  if (inputTokens === undefined || outputTokens === undefined) return undefined;
  const cachedInputTokens = object(input_tokens_details) ? cacheTokens(input_tokens_details.cached_tokens, inputTokens) : undefined;
  return { inputTokens, outputTokens, cachedInputTokens: cachedInputTokens ?? null };
}

export function responsesEventUsage(value: unknown, event?: string): TokenUsage | undefined {
  if (!object(value)) return undefined;
  const type = value.type ?? event;
  if (type !== 'response.completed' && type !== 'response.incomplete' && type !== 'response.failed') return undefined;
  return responsesUsage(value.response);
}

export function chatUsage(value: unknown): TokenUsage | undefined {
  if (!object(value) || !object(value.usage)) return undefined;
  const usage = value.usage;
  const hit = tokens(usage.prompt_cache_hit_tokens);
  const miss = tokens(usage.prompt_cache_miss_tokens);
  const inputTokens = tokens(usage.prompt_tokens) ?? (hit !== undefined && miss !== undefined ? tokens(hit + miss) : undefined);
  const outputTokens = tokens(usage.completion_tokens);
  if (inputTokens === undefined || outputTokens === undefined) return undefined;
  const details = object(usage.prompt_tokens_details) ? cacheTokens(usage.prompt_tokens_details.cached_tokens, inputTokens) : undefined;
  const cachedInputTokens = details ?? cacheTokens(usage.cached_tokens, inputTokens) ?? cacheTokens(hit, inputTokens) ??
    (miss !== undefined && miss <= inputTokens ? inputTokens - miss : null);
  return { inputTokens, outputTokens, cachedInputTokens };
}

function tap(inspect: (chunk: Buffer) => void, finish: () => void): Transform {
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      try { inspect(chunk); } catch { /* Usage observation cannot interrupt delivery. */ }
      callback(null, chunk);
    },
    flush(callback) {
      try { finish(); } catch { /* Malformed or unavailable usage does not affect the provider response. */ }
      callback();
    },
  });
}

/** Inspect provider usage in a bounded side buffer while forwarding the original bytes. */
export function tapResponsesUsage(streaming: boolean, observe: UsageObserver): Transform {
  if (!streaming) {
    const chunks: Buffer[] = [];
    let bytes = 0;
    return tap((chunk) => {
      bytes += chunk.length;
      if (bytes <= MAX_OBSERVED_JSON_BYTES) chunks.push(chunk);
      else chunks.length = 0;
    }, () => {
      if (chunks.length) observe(responsesUsage(JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'))));
    });
  }

  const decoder = new TextDecoder();
  let pending = '';
  let discardFrame = false;
  const inspectFrame = (frame: string): void => {
    const parsed = parseSseFrame(frame);
    if (parsed) observe(responsesEventUsage(parsed.value, parsed.event));
  };
  const inspect = (text: string): void => {
    pending += text;
    let separator: RegExpExecArray | null;
    while ((separator = SSE_FRAME_BREAK.exec(pending))) {
      if (!discardFrame && separator.index <= MAX_SSE_FRAME_LENGTH) inspectFrame(pending.slice(0, separator.index));
      discardFrame = false;
      pending = pending.slice(separator.index + separator[0].length);
    }
    if (pending.length > MAX_SSE_FRAME_LENGTH) {
      discardFrame = true;
      // Keep enough of a discarded frame's tail to find a separator split across chunks.
      pending = pending.slice(-3);
    }
  };
  return tap((chunk) => inspect(decoder.decode(chunk, { stream: true })), () => {
    inspect(decoder.decode());
    if (!discardFrame && pending) inspectFrame(pending);
  });
}
