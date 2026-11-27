import { createHmac, timingSafeEqual } from 'node:crypto';
import { BridgeRequestError } from './errors';

const MAX_JSON_BYTES = 64 * 1024 * 1024;
const MAX_FRAME_LENGTH = 8 * 1024 * 1024;
const SSE_LINE_BREAK = /\r\n|\n|\r/;
const SSE_FRAME_BREAK = /(?:\r\n|\n|\r(?!\n))(?:\r\n|\n|\r(?!\n))/;
const PROVENANCE_MARKER = 'agent-switcher-v1.';

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function signature(value: string, key: Buffer): string {
  return createHmac('sha256', key).update(value).digest('base64url');
}

function wrap(value: string, key: Buffer): string {
  return `${PROVENANCE_MARKER}${signature(value, key)}.${value}`;
}

function unwrap(value: string, key: Buffer): string | undefined {
  if (!value.startsWith(PROVENANCE_MARKER)) return undefined;
  const separator = value.indexOf('.', PROVENANCE_MARKER.length);
  if (separator !== PROVENANCE_MARKER.length + 43) return undefined;
  const ciphertext = value.slice(separator + 1);
  const supplied = Buffer.from(value.slice(PROVENANCE_MARKER.length, separator));
  const expected = Buffer.from(signature(ciphertext, key));
  return supplied.length === expected.length && timingSafeEqual(supplied, expected) ? ciphertext : undefined;
}

function restoreItem(item: Record<string, unknown>, key?: Buffer): Record<string, unknown> | undefined {
  const { encrypted_content: content, encrypted_function_args: args, ...portable } = item;
  const ciphertext = key && typeof content === 'string' ? unwrap(content, key) : undefined;
  const isCompaction = item.type === 'compaction' || item.type === 'context_compaction';
  if (isCompaction && ciphertext === undefined) return undefined;

  if (item.type === 'reasoning' && content != null && ciphertext === undefined) {
    const visible = (Array.isArray(item.summary) && item.summary.length > 0) || (Array.isArray(item.content) && item.content.length > 0);
    if (!visible) return undefined;
    delete portable.id;
    portable.encrypted_content = null;
  } else if (ciphertext !== undefined || content === null) {
    portable.encrypted_content = ciphertext ?? null;
  }

  if (key && Array.isArray(args)) {
    const restored = args.map((arg: unknown) => typeof arg === 'string' ? unwrap(arg, key) : undefined);
    if (restored.every((arg) => arg !== undefined)) portable.encrypted_function_args = restored;
  }
  return portable;
}

export function prepareRoutedInput(input: Record<string, unknown>, key?: Buffer): Record<string, unknown> {
  const requiresFullHistory = 'Combined API connections require full conversation history. Start a new chat to use this model.';
  if (input.previous_response_id != null || input.conversation != null) {
    throw new BridgeRequestError(400, requiresFullHistory);
  }
  if (!Array.isArray(input.input)) return input;
  const history: unknown[] = [];
  for (const item of input.input as unknown[]) {
    if (object(item) && item.type === 'item_reference') throw new BridgeRequestError(400, requiresFullHistory);
    // Restore authenticated opaque fields for this route and preserve the portable history.
    const restored = object(item) ? restoreItem(item, key) : item;
    if (restored !== undefined) history.push(restored);
  }
  return { ...input, input: history };
}

function wrapItem(item: unknown, key: Buffer): boolean {
  if (!object(item)) return false;
  let changed = false;
  if (typeof item.encrypted_content === 'string' && item.encrypted_content) {
    item.encrypted_content = wrap(item.encrypted_content, key);
    changed = true;
  }
  if (Array.isArray(item.encrypted_function_args) && item.encrypted_function_args.length > 0) {
    item.encrypted_function_args = item.encrypted_function_args.map((arg: unknown) => typeof arg === 'string' ? wrap(arg, key) : arg);
    changed = true;
  }
  return changed;
}

function wrapEnvelope(value: unknown, key: Buffer): boolean {
  if (!object(value)) return false;
  const envelope = object(value.response) ? value.response : value;
  let changed = wrapItem(value.item, key);
  if (Array.isArray(envelope.output)) {
    for (const item of envelope.output as unknown[]) if (wrapItem(item, key)) changed = true;
  }
  return changed;
}

export async function wrapRoutedJson(body: ReadableStream<Uint8Array>, key: Buffer): Promise<Buffer | string> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_JSON_BYTES) throw new BridgeRequestError(502, 'The provider response is too large.');
      chunks.push(value);
    }
    const raw = Buffer.concat(chunks, bytes);
    let parsed: unknown;
    try { parsed = JSON.parse(raw.toString('utf8')); }
    catch { throw new BridgeRequestError(502, 'The provider returned invalid Responses JSON.'); }
    return wrapEnvelope(parsed, key) ? JSON.stringify(parsed) : raw;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function wrapFrame(frame: string, key: Buffer): string {
  const lines = frame.split(SSE_LINE_BREAK);
  const data: string[] = [];
  const other: string[] = [];
  let dataStart = -1;
  for (const line of lines) {
    if (line.startsWith('data:') || line === 'data') {
      if (dataStart === -1) dataStart = other.length;
      data.push(line.slice(5).replace(/^ /, ''));
    } else other.push(line);
  }
  if (dataStart === -1) return frame;
  let parsed: unknown;
  try { parsed = JSON.parse(data.join('\n')); }
  catch { return frame; }
  if (!wrapEnvelope(parsed, key)) return frame;
  other.splice(dataStart, 0, `data: ${JSON.stringify(parsed)}`);
  return other.join(SSE_LINE_BREAK.exec(frame)?.[0] ?? '\n');
}

export async function* wrapRoutedStream(body: ReadableStream<Uint8Array>, key: Buffer): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      let separator: RegExpExecArray | null;
      while ((separator = SSE_FRAME_BREAK.exec(pending))) {
        if (separator.index > MAX_FRAME_LENGTH) throw new BridgeRequestError(502, 'The provider response event is too large.');
        yield wrapFrame(pending.slice(0, separator.index), key) + separator[0];
        pending = pending.slice(separator.index + separator[0].length);
      }
      if (pending.length > MAX_FRAME_LENGTH) throw new BridgeRequestError(502, 'The provider response event is too large.');
      if (done) break;
    }
    if (pending) yield wrapFrame(pending, key);
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
