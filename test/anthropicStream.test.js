import { test } from "node:test";
import assert from "node:assert/strict";
import { translateAnthropicStreamEvent } from "../src/providers/anthropic.js";

test("message_start sets state and emits a role-announcement chunk with empty content", () => {
  const state = {};
  const chunk = translateAnthropicStreamEvent(
    { type: "message_start", message: { id: "msg_1", model: "claude-sonnet-4-6", usage: { input_tokens: 42, cache_read_input_tokens: 5, cache_creation_input_tokens: 0 } } },
    state
  );
  assert.equal(chunk.id, "msg_1");
  assert.equal(chunk.object, "chat.completion.chunk");
  assert.equal(chunk.choices[0].delta.role, "assistant");
  assert.equal(chunk.choices[0].delta.content, "");
  assert.equal(chunk.choices[0].finish_reason, null);
  assert.equal(state.inputTokens, 42);
  assert.equal(state.cacheReadInputTokens, 5);
});

test("content_block_delta with text_delta emits a content chunk", () => {
  const state = { id: "msg_1", model: "claude-sonnet-4-6" };
  const chunk = translateAnthropicStreamEvent({ type: "content_block_delta", delta: { type: "text_delta", text: "Hello" } }, state);
  assert.equal(chunk.choices[0].delta.content, "Hello");
  assert.equal(chunk.choices[0].finish_reason, null);
});

test("content_block_delta with a non-text delta type is ignored", () => {
  const chunk = translateAnthropicStreamEvent({ type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "{}" } }, {});
  assert.equal(chunk, null);
});

test("message_delta emits the final chunk with usage and a mapped finish_reason", () => {
  const state = { id: "msg_1", model: "claude-sonnet-4-6", inputTokens: 42, outputTokens: 0 };
  const chunk = translateAnthropicStreamEvent({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 17 } }, state);
  assert.equal(chunk.choices[0].finish_reason, "stop");
  assert.deepEqual(chunk.usage, { prompt_tokens: 42, completion_tokens: 17, total_tokens: 59 });
  assert.equal(state.outputTokens, 17);
});

test("message_delta maps max_tokens stop_reason to a 'length' finish_reason", () => {
  const chunk = translateAnthropicStreamEvent({ type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 5 } }, { inputTokens: 10 });
  assert.equal(chunk.choices[0].finish_reason, "length");
});

test("an unrecognized stop_reason falls back to 'stop' rather than throwing", () => {
  const chunk = translateAnthropicStreamEvent({ type: "message_delta", delta: { stop_reason: "something_new" }, usage: { output_tokens: 1 } }, { inputTokens: 1 });
  assert.equal(chunk.choices[0].finish_reason, "stop");
});

test("ping, content_block_start/stop, and message_stop produce no client-visible chunk", () => {
  for (const type of ["ping", "content_block_start", "content_block_stop", "message_stop"]) {
    assert.equal(translateAnthropicStreamEvent({ type }, {}), null);
  }
});

test("a full realistic event sequence accumulates to the right final content and usage", () => {
  const events = [
    { type: "message_start", message: { id: "msg_2", model: "claude-haiku-4-5-20251001", usage: { input_tokens: 20 } } },
    { type: "content_block_start" },
    { type: "content_block_delta", delta: { type: "text_delta", text: "The " } },
    { type: "content_block_delta", delta: { type: "text_delta", text: "answer " } },
    { type: "content_block_delta", delta: { type: "text_delta", text: "is 42." } },
    { type: "content_block_stop" },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 6 } },
    { type: "message_stop" },
  ];

  const state = {};
  let content = "";
  let finalChunk = null;
  for (const event of events) {
    const chunk = translateAnthropicStreamEvent(event, state);
    if (!chunk) continue;
    if (chunk.choices[0].delta.content) content += chunk.choices[0].delta.content;
    if (chunk.choices[0].finish_reason) finalChunk = chunk;
  }

  assert.equal(content, "The answer is 42.");
  assert.equal(finalChunk.choices[0].finish_reason, "stop");
  assert.deepEqual(finalChunk.usage, { prompt_tokens: 20, completion_tokens: 6, total_tokens: 26 });
});
