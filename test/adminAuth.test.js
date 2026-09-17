import { test } from "node:test";
import assert from "node:assert/strict";
import { adminAuth } from "../src/middleware/adminAuth.js";

function call(token, header) {
  let status = null, body = null, nextCalled = false;
  const req = { get: (name) => (name.toLowerCase() === "authorization" ? header : undefined) };
  const res = { status(code) { status = code; return this; }, json(payload) { body = payload; return this; } };
  const previous = process.env.ADMIN_TOKEN;
  if (token === undefined) delete process.env.ADMIN_TOKEN; else process.env.ADMIN_TOKEN = token;
  try {
    adminAuth()(req, res, () => { nextCalled = true; });
  } finally {
    if (previous === undefined) delete process.env.ADMIN_TOKEN; else process.env.ADMIN_TOKEN = previous;
  }
  return { status, body, nextCalled };
}

test("no ADMIN_TOKEN configured refuses everything -- fail closed, not open", () => {
  const result = call(undefined, "Bearer anything");
  assert.equal(result.nextCalled, false);
  assert.equal(result.status, 503);
  assert.equal(result.body.error.type, "admin_not_configured");
});

test("correct token calls next() with no error response", () => {
  const result = call("secret-admin-token", "Bearer secret-admin-token");
  assert.equal(result.nextCalled, true);
  assert.equal(result.status, null);
});

test("wrong token, missing header, and non-Bearer header are all rejected", () => {
  for (const header of ["Bearer wrong-token", undefined, "secret-admin-token", "Basic secret-admin-token"]) {
    const result = call("secret-admin-token", header);
    assert.equal(result.nextCalled, false);
    assert.equal(result.status, 401);
  }
});

test("a customer's api_key never satisfies admin auth, even if it happens to match length", () => {
  // Same length as the configured admin token -- proves this isn't a length-only check.
  const result = call("aaaaaaaaaaaaaaaaaaaa", "Bearer bbbbbbbbbbbbbbbbbbbb");
  assert.equal(result.nextCalled, false);
  assert.equal(result.status, 401);
});
