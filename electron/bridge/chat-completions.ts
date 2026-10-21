import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { ServerResponse } from 'node:http';
import { BridgeRequestError } from './errors';

type ObjectValue = Record<string, unknown>;
type ToolDefinition = { name: string; namespace?: string; custom: boolean };
export interface ChatRequest {
  body: ObjectValue;
  tools: Map<string, ToolDefinition>;
  model: string;
  responseTools: unknown[];
  responseToolChoice: unknown;
}

function object(value: unknown): value is ObjectValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function invalid(message: string): never {
  throw new BridgeRequestError(400, `The Chat Completions connection cannot handle this request: ${message}`);
}

function malformed(): never {
  throw new BridgeRequestError(502, 'The provider returned an invalid Chat Completions response.');
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string') invalid(`${label} must be text.`);
  return value;
}

function messageContent(value: unknown, role: string): unknown {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) invalid('Message content must be text or a content array.');
  return value.map((part: unknown) => {
    if (!object(part)) invalid('Message content is invalid.');
    if (['input_text', 'output_text', 'text'].includes(String(part.type))) {
      return { type: 'text', text: string(part.text, 'Message text') };
    }
    if (part.type === 'input_image' && role === 'user' && typeof part.image_url === 'string') {
      return { type: 'image_url', image_url: { url: part.image_url, ...(typeof part.detail === 'string' ? { detail: part.detail } : {}) } };
    }
    invalid('This content type requires a native Responses connection.');
  });
}

function toolOutput(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map((part: unknown) => {
      if (object(part) && ['input_text', 'output_text', 'text'].includes(String(part.type))) return string(part.text, 'Tool output');
      invalid('Non-text tool results require a native Responses connection.');
    }).join('\n');
  }
  invalid('Tool output must be text.');
}

/** Translate stateless Responses history, including real tool round trips. */
export function toChatRequest(input: ObjectValue, model: string): ChatRequest {
  if (input.previous_response_id) invalid('previous_response_id requires a native Responses connection. Send the complete conversation history instead.');
  if (input.conversation || input.background === true) invalid('Server-side conversation state requires a native Responses connection.');
  const tools = new Map<string, ToolDefinition>();
  const chatTools: ObjectValue[] = [];
  if (input.tools !== undefined) {
    if (!Array.isArray(input.tools)) invalid('Tools must be an array.');
    const add = (value: unknown, namespace?: string, namespaceDescription?: string): void => {
      if (!object(value)) invalid('Tool definitions must be objects.');
      if (value.type === 'namespace') {
        if (namespace || typeof value.name !== 'string' || !value.name || !Array.isArray(value.tools)) invalid('The tool namespace is invalid.');
        for (const nested of value.tools as unknown[]) add(nested, value.name, typeof value.description === 'string' ? value.description : undefined);
        return;
      }
      if (!['function', 'custom'].includes(String(value.type))) invalid('Hosted tools require a native Responses connection.');
      const name = string(value.name, 'Tool name');
      if (!name || name.length > 128) invalid('Tool names must contain 1 to 128 characters.');
      const qualified = namespace ? `${namespace}__${name}` : name;
      const wireName = /^[a-zA-Z0-9_-]{1,64}$/.test(qualified) ? qualified : `tool_${createHash('sha256').update(JSON.stringify([namespace, name])).digest('hex').slice(0, 48)}`;
      if (tools.has(wireName)) invalid('Tool names must be unique.');
      const custom = value.type === 'custom';
      tools.set(wireName, { name, custom, ...(namespace ? { namespace } : {}) });
      const format = object(value.format) && typeof value.format.definition === 'string' ? `\nInput grammar (${String(value.format.syntax ?? 'text')}):\n${value.format.definition}` : '';
      const description = [namespaceDescription, typeof value.description === 'string' ? value.description : ''].filter(Boolean).join('\n');
      chatTools.push({ type: 'function', function: {
        name: wireName,
        ...(description ? { description } : {}),
        parameters: custom ? {
          type: 'object', properties: { input: { type: 'string', description: `The exact freeform tool input.${format}` } },
          required: ['input'], additionalProperties: false,
        } : value.parameters ?? { type: 'object', properties: {} },
        ...(typeof value.strict === 'boolean' ? { strict: value.strict } : {}),
      } });
    };
    for (const value of input.tools) add(value);
  }
  const wireName = (name: string, namespace?: unknown): string => {
    for (const [wire, definition] of tools) if (definition.name === name && definition.namespace === (namespace ?? undefined)) return wire;
    if (namespace) invalid('A namespaced history tool is missing from the supplied tool definitions.');
    return name;
  };
  const messages: ObjectValue[] = [];
  if (input.instructions !== undefined && input.instructions !== null) messages.push({ role: 'system', content: string(input.instructions, 'Instructions') });
  let reasoning = '';
  const history = typeof input.input === 'string' ? [{ role: 'user', content: input.input }] : input.input;
  if (!Array.isArray(history)) invalid('Input must be text or a conversation array.');
  for (const value of history) {
    if (!object(value)) invalid('Conversation items must be objects.');
    const type = value.type ?? 'message';
    if (type === 'reasoning') {
      if (value.encrypted_content) invalid('Encrypted reasoning history requires a native Responses connection.');
      // Thinking providers need reasoning_content on the assistant tool turn.
      const summary = Array.isArray(value.summary) ? value.summary : [];
      reasoning += summary.map((part: unknown) => object(part) && typeof part.text === 'string' ? part.text : '').join('\n');
      continue;
    }
    if (type === 'message') {
      const role = value.role === 'developer' ? 'system' : value.role;
      if (!['system', 'user', 'assistant'].includes(String(role))) invalid('This message role is unsupported.');
      messages.push({ role, content: messageContent(value.content, String(role)), ...(role === 'assistant' && reasoning ? { reasoning_content: reasoning } : {}) });
      if (role === 'assistant') reasoning = '';
      continue;
    }
    if (type === 'function_call' || type === 'custom_tool_call') {
      const callId = string(value.call_id, 'Tool call ID');
      const name = wireName(string(value.name, 'Tool name'), value.namespace);
      const args = type === 'custom_tool_call' ? JSON.stringify({ input: string(value.input, 'Custom tool input') }) : string(value.arguments, 'Function arguments');
      const call = { id: callId, type: 'function', function: { name, arguments: args } };
      const previous = messages.at(-1);
      if (previous?.role === 'assistant') {
        const calls = Array.isArray(previous.tool_calls) ? previous.tool_calls : [];
        calls.push(call);
        previous.tool_calls = calls;
        if (reasoning) previous.reasoning_content = reasoning;
      } else messages.push({ role: 'assistant', content: null, tool_calls: [call], ...(reasoning ? { reasoning_content: reasoning } : {}) });
      reasoning = '';
      continue;
    }
    if (type === 'function_call_output' || type === 'custom_tool_call_output') {
      messages.push({ role: 'tool', tool_call_id: string(value.call_id, 'Tool call ID'), content: toolOutput(value.output) });
      continue;
    }
    invalid('This conversation item requires a native Responses connection.');
  }
  const body: ObjectValue = { model, messages, stream: input.stream === true };
  if (chatTools.length) body.tools = chatTools;
  if (input.tool_choice !== undefined) {
    if (typeof input.tool_choice === 'string' && ['auto', 'none', 'required'].includes(input.tool_choice)) body.tool_choice = input.tool_choice;
    else if (object(input.tool_choice) && ['function', 'custom'].includes(String(input.tool_choice.type)) && typeof input.tool_choice.name === 'string') {
      body.tool_choice = { type: 'function', function: { name: wireName(input.tool_choice.name, input.tool_choice.namespace) } };
    } else invalid('This tool choice requires a native Responses connection.');
  }
  for (const key of ['temperature', 'top_p', 'parallel_tool_calls'] as const) if (input[key] !== undefined) body[key] = input[key];
  if (input.max_output_tokens !== undefined) body.max_tokens = input.max_output_tokens;
  if (object(input.reasoning) && typeof input.reasoning.effort === 'string') body.reasoning_effort = input.reasoning.effort;
  if (object(input.text) && object(input.text.format)) {
    const format = input.text.format;
    if (format.type === 'json_object') body.response_format = { type: 'json_object' };
    else if (format.type === 'json_schema') body.response_format = { type: 'json_schema', json_schema: { name: format.name, schema: format.schema, ...(format.strict !== undefined ? { strict: format.strict } : {}) } };
  }
  if (body.stream) body.stream_options = { include_usage: true };
  return { body, tools, model, responseTools: Array.isArray(input.tools) ? input.tools : [], responseToolChoice: input.tool_choice ?? 'auto' };
}

function responseEnvelope(request: ChatRequest, status = 'in_progress'): ObjectValue {
  return {
    id: `resp_${randomUUID().replaceAll('-', '')}`, object: 'response', created_at: Math.floor(Date.now() / 1000),
    status, error: null, incomplete_details: null, instructions: null, model: request.model,
    output: [], parallel_tool_calls: request.body.parallel_tool_calls ?? true, tool_choice: request.responseToolChoice,
    tools: request.responseTools, usage: null,
  };
}

function usage(value: unknown): ObjectValue | null {
  if (!object(value)) return null;
  const number = (field: unknown): number => typeof field === 'number' && Number.isFinite(field) ? field : 0;
  return {
    input_tokens: number(value.prompt_tokens), output_tokens: number(value.completion_tokens), total_tokens: number(value.total_tokens),
    input_tokens_details: { cached_tokens: object(value.prompt_tokens_details) ? number(value.prompt_tokens_details.cached_tokens) : 0 },
    output_tokens_details: { reasoning_tokens: object(value.completion_tokens_details) ? number(value.completion_tokens_details.reasoning_tokens) : 0 },
  };
}

function finish(response: ObjectValue, reason: unknown): void {
  if (!['stop', 'tool_calls', 'function_call', 'length', 'content_filter'].includes(String(reason))) malformed();
  response.status = reason === 'length' || reason === 'content_filter' ? 'incomplete' : 'completed';
  response.incomplete_details = reason === 'length' ? { reason: 'max_output_tokens' } : reason === 'content_filter' ? { reason: 'content_filter' } : null;
}

function toolItem(name: string, args: string, callId: string, request: ChatRequest, id?: string): ObjectValue {
  const definition = request.tools.get(name);
  if (!definition) malformed();
  if (definition.custom) {
    let parsed: unknown;
    try { parsed = JSON.parse(args); } catch { malformed(); }
    if (!object(parsed) || typeof parsed.input !== 'string') malformed();
    return { id: id ?? `ctc_${randomUUID().replaceAll('-', '')}`, type: 'custom_tool_call', call_id: callId, name: definition.name, ...(definition.namespace ? { namespace: definition.namespace } : {}), input: parsed.input, status: 'completed' };
  }
  return { id: id ?? `fc_${randomUUID().replaceAll('-', '')}`, type: 'function_call', call_id: callId, name: definition.name, ...(definition.namespace ? { namespace: definition.namespace } : {}), arguments: args, status: 'completed' };
}

export function fromChatResponse(value: unknown, request: ChatRequest): ObjectValue {
  if (!object(value) || value.error || !Array.isArray(value.choices) || value.choices.length !== 1) malformed();
  const choice: unknown = value.choices[0];
  if (!object(choice) || !object(choice.message)) malformed();
  const message = choice.message;
  if (message.audio || message.function_call) malformed();
  const output: ObjectValue[] = [];
  if (typeof message.reasoning_content === 'string' && message.reasoning_content) output.push({ id: `rs_${randomUUID().replaceAll('-', '')}`, type: 'reasoning', summary: [{ type: 'summary_text', text: message.reasoning_content }] });
  if (typeof message.content === 'string' && message.content) output.push({ id: `msg_${randomUUID().replaceAll('-', '')}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: message.content, annotations: [] }] });
  else if (message.content !== null && message.content !== undefined && message.content !== '') malformed();
  if (Array.isArray(message.tool_calls)) for (const call of message.tool_calls as unknown[]) {
    if (!object(call) || call.type !== 'function' || typeof call.id !== 'string' || !object(call.function) || typeof call.function.name !== 'string' || typeof call.function.arguments !== 'string') malformed();
    output.push(toolItem(call.function.name, call.function.arguments, call.id, request));
  }
  if (typeof message.refusal === 'string' && message.refusal) output.push({ id: `msg_${randomUUID().replaceAll('-', '')}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'refusal', refusal: message.refusal }] });
  const response = responseEnvelope(request);
  finish(response, choice.finish_reason);
  response.output = output;
  response.usage = usage(value.usage);
  return response;
}

interface StreamTool {
  item: ObjectValue;
  outputIndex: number;
  name: string;
  callId: string;
  arguments: string;
  custom: boolean;
}

/** Parse SSE incrementally: UTF-8 and event frames may cross any network chunk. */
async function* chatChunks(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let doneMarker = false;
  try {
    while (true) {
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      if (buffer.length > 8 * 1024 * 1024) malformed();
      let match: RegExpExecArray | null;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        const frame = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const data = frame.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).replace(/^ /, '')).join('\n');
        if (!data) continue;
        if (data === '[DONE]') { doneMarker = true; break; }
        let parsed: unknown;
        try { parsed = JSON.parse(data); } catch { malformed(); }
        yield parsed;
      }
      if (doneMarker || chunk.done) break;
    }
    if (buffer.trim() && !doneMarker) malformed();
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** Produce Responses events Codex can consume, with stable item IDs and indexes. */
export async function streamChatResponse(body: ReadableStream<Uint8Array>, request: ChatRequest, response: ServerResponse, signal: AbortSignal): Promise<void> {
  let sequence = 0;
  const envelope = responseEnvelope(request);
  const output: ObjectValue[] = [];
  const calls = new Map<number, StreamTool>();
  let text: ObjectValue | undefined;
  let textIndex = -1;
  let textValue = '';
  let reasoning: ObjectValue | undefined;
  let reasoningIndex = -1;
  let reasoningValue = '';
  let finishReason: unknown;
  const emit = async (type: string, fields: ObjectValue): Promise<void> => {
    if (signal.aborted || response.destroyed) throw new Error('Cancelled');
    const event = { type, sequence_number: sequence++, ...fields };
    if (!response.write(`event: ${type}\ndata: ${JSON.stringify(event)}\n\n`)) await once(response, 'drain', { signal });
  };
  try {
    await emit('response.created', { response: { ...envelope, output: [] } });
    await emit('response.in_progress', { response: { ...envelope, output: [] } });
    for await (const chunk of chatChunks(body)) {
      if (!object(chunk) || chunk.error || !Array.isArray(chunk.choices) || chunk.choices.length > 1) malformed();
      if (chunk.usage) envelope.usage = usage(chunk.usage);
      if (chunk.choices.length === 0) continue;
      const choice: unknown = chunk.choices[0];
      if (!object(choice) || !object(choice.delta)) malformed();
      const delta = choice.delta;
      if ((delta.content !== undefined && delta.content !== null && typeof delta.content !== 'string') || delta.audio || delta.function_call) malformed();
      if (choice.finish_reason !== null && choice.finish_reason !== undefined) finishReason = choice.finish_reason;
      if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
        if (!reasoning) {
          reasoningIndex = output.length;
          reasoning = { id: `rs_${randomUUID().replaceAll('-', '')}`, type: 'reasoning', summary: [] };
          output.push(reasoning);
          await emit('response.output_item.added', { output_index: reasoningIndex, item: { ...reasoning } });
          await emit('response.reasoning_summary_part.added', { item_id: reasoning.id, output_index: reasoningIndex, summary_index: 0, part: { type: 'summary_text', text: '' } });
        }
        reasoningValue += delta.reasoning_content;
        await emit('response.reasoning_summary_text.delta', { item_id: reasoning.id, output_index: reasoningIndex, summary_index: 0, delta: delta.reasoning_content });
      }
      if (typeof delta.content === 'string' && delta.content) {
        if (!text) {
          textIndex = output.length;
          text = { id: `msg_${randomUUID().replaceAll('-', '')}`, type: 'message', role: 'assistant', status: 'in_progress', content: [] };
          output.push(text);
          await emit('response.output_item.added', { output_index: textIndex, item: { ...text } });
          await emit('response.content_part.added', { item_id: text.id, output_index: textIndex, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
        }
        textValue += delta.content;
        await emit('response.output_text.delta', { item_id: text.id, output_index: textIndex, content_index: 0, delta: delta.content });
      }
      if (Array.isArray(delta.tool_calls)) for (const raw of delta.tool_calls as unknown[]) {
        if (!object(raw) || !Number.isInteger(raw.index) || (raw.index as number) < 0 || !object(raw.function)) malformed();
        const index = raw.index as number;
        let call = calls.get(index);
        if (!call) {
          if (typeof raw.function.name !== 'string' || typeof raw.id !== 'string' || !request.tools.has(raw.function.name)) malformed();
          const custom = request.tools.get(raw.function.name)?.custom ?? false;
          const definition = request.tools.get(raw.function.name);
          const item: ObjectValue = { id: `${custom ? 'ctc' : 'fc'}_${randomUUID().replaceAll('-', '')}`, type: custom ? 'custom_tool_call' : 'function_call', call_id: raw.id, name: definition?.name, ...(definition?.namespace ? { namespace: definition.namespace } : {}), status: 'in_progress', ...(custom ? { input: '' } : { arguments: '' }) };
          call = { item, outputIndex: output.length, name: raw.function.name, callId: raw.id, arguments: '', custom };
          calls.set(index, call);
          output.push(item);
          await emit('response.output_item.added', { output_index: call.outputIndex, item: { ...item } });
        } else if ((typeof raw.id === 'string' && raw.id !== call.callId) || (typeof raw.function.name === 'string' && raw.function.name && raw.function.name !== call.name)) malformed();
        if (raw.function.arguments !== undefined && typeof raw.function.arguments !== 'string') malformed();
        const args = typeof raw.function.arguments === 'string' ? raw.function.arguments : '';
        call.arguments += args;
        if (call.arguments.length > 64 * 1024 * 1024) malformed();
        if (args && !call.custom) await emit('response.function_call_arguments.delta', { item_id: call.item.id, output_index: call.outputIndex, delta: args });
      }
      if (typeof delta.refusal === 'string' && delta.refusal) malformed();
    }
    // EOF without a terminal choice is an interrupted generation, never success.
    finish(envelope, finishReason);
    if (reasoning) {
      const part = { type: 'summary_text', text: reasoningValue };
      reasoning.summary = [part];
      await emit('response.reasoning_summary_text.done', { item_id: reasoning.id, output_index: reasoningIndex, summary_index: 0, text: reasoningValue });
      await emit('response.reasoning_summary_part.done', { item_id: reasoning.id, output_index: reasoningIndex, summary_index: 0, part });
      await emit('response.output_item.done', { output_index: reasoningIndex, item: reasoning });
    }
    if (text) {
      const part = { type: 'output_text', text: textValue, annotations: [] };
      text.status = 'completed';
      text.content = [part];
      await emit('response.output_text.done', { item_id: text.id, output_index: textIndex, content_index: 0, text: textValue });
      await emit('response.content_part.done', { item_id: text.id, output_index: textIndex, content_index: 0, part });
      await emit('response.output_item.done', { output_index: textIndex, item: text });
    }
    for (const call of calls.values()) {
      const final = toolItem(call.name, call.arguments, call.callId, request, String(call.item.id));
      Object.assign(call.item, final);
      if (call.custom) {
        await emit('response.custom_tool_call_input.delta', { item_id: call.item.id, output_index: call.outputIndex, delta: final.input });
        await emit('response.custom_tool_call_input.done', { item_id: call.item.id, output_index: call.outputIndex, input: final.input });
      } else await emit('response.function_call_arguments.done', { item_id: call.item.id, output_index: call.outputIndex, arguments: call.arguments });
      await emit('response.output_item.done', { output_index: call.outputIndex, item: call.item });
    }
    envelope.output = output;
    await emit(envelope.status === 'completed' ? 'response.completed' : 'response.incomplete', { response: envelope });
    response.end();
  } catch (error) {
    if (signal.aborted || response.destroyed) throw error;
    envelope.status = 'failed';
    envelope.output = output;
    envelope.error = { code: 'invalid_chat_response', message: error instanceof BridgeRequestError ? error.message : 'The provider Chat Completions stream was interrupted.' };
    await emit('response.failed', { response: envelope });
    response.end();
  }
}
