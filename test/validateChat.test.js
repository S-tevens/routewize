import { test } from "node:test";
import assert from "node:assert/strict";
import { validateChat } from "../src/middleware/validateChat.js";

const body = (overrides = {}) => ({ messages: [{ role: "user", content: "hi" }], ...overrides });

test("a minimal valid body does not throw", () => {
  assert.doesNotThrow(() => validateChat(body()));
});

test("messages must be a non-empty array of well-shaped {role, content}", () => {
  assert.throws(() => validateChat({}), /messages must be a non-empty array/);
  assert.throws(() => validateChat({ messages: [] }), /messages must be a non-empty array/);
  assert.throws(() => validateChat({ messages: [{ role: "narrator", content: "hi" }] }), /role must be system, user or assistant/);
  assert.throws(() => validateChat({ messages: [{ role: "user", content: 42 }] }), /content must be a string/);
  assert.throws(() => validateChat({ messages: [{ role: "user", content: "hi", tool_call_id: "x" }] }), /Unsupported message field/);
});

test("a real OpenAI SDK request isn't broken -- standard fields it commonly sends are accepted and ignored", () => {
  // These aren't wired to anything yet, but rejecting them would break
  // "same code, just change the base URL" for any client that sets one.
  assert.doesNotThrow(() => validateChat(body({ top_p: 1, presence_penalty: 0, frequency_penalty: 0, stop: ["\n"], user: "end-user-123", seed: 7, n: 1, logprobs: true, top_logprobs: 2, stream_options: { include_usage: true }, logit_bias: { "50256": -100 } })));
});

test("message 'name' field is accepted (standard OpenAI field), unknown fields are not", () => {
  assert.doesNotThrow(() => validateChat({ messages: [{ role: "user", content: "hi", name: "alice" }] }));
  assert.throws(() => validateChat({ messages: [{ role: "user", content: "hi", name: 5 }] }), /name must be a string/);
});

test("tools/response_format get a specific, informative error rather than a generic one", () => {
  assert.throws(() => validateChat(body({ tools: [{ type: "function" }] })), /tools and response_format are not supported/);
  assert.throws(() => validateChat(body({ response_format: { type: "json_object" } })), /tools and response_format are not supported/);
  assert.throws(() => validateChat(body({ function_call: "auto" })), /tools and response_format are not supported/);
});

test("a genuinely unrecognized top-level option is rejected by name", () => {
  assert.throws(() => validateChat(body({ definitely_not_a_real_field: true })), /Unsupported option: definitely_not_a_real_field/);
});

test("model, max_tokens, temperature, stream and force_flagship are type/range checked", () => {
  assert.throws(() => validateChat(body({ model: "" })), /model must be a non-empty string/);
  assert.throws(() => validateChat(body({ max_tokens: 0 })), /max_tokens must be a positive safe integer/);
  assert.throws(() => validateChat(body({ max_tokens: 1.5 })), /max_tokens must be a positive safe integer/);
  assert.throws(() => validateChat(body({ temperature: 2.1 })), /temperature must be between 0 and 2/);
  assert.throws(() => validateChat(body({ temperature: -0.1 })), /temperature must be between 0 and 2/);
  assert.throws(() => validateChat(body({ stream: "true" })), /stream must be a boolean/);
  assert.throws(() => validateChat(body({ force_flagship: 1 })), /force_flagship must be a boolean/);
  assert.doesNotThrow(() => validateChat(body({ model: "gpt-4o", max_tokens: 512, temperature: 0.7, stream: true, force_flagship: false })));
});

test("the request body itself must be a plain object", () => {
  assert.throws(() => validateChat(null), /Request body must be an object/);
  assert.throws(() => validateChat([]), /Request body must be an object/);
  assert.throws(() => validateChat("hi"), /Request body must be an object/);
});
