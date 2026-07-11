/// <reference lib="dom" />
/// <reference lib="dom.iterable" />

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { redactUiError } from "../src/ui";

describe("redactUiError", () => {
  it("removes bearer tokens and API-key-shaped values before console logging", () => {
    const secret = "sk-proj-abcdefghijk123456";
    const message = redactUiError(new Error(`Authorization: Bearer ${secret}`));
    assert.equal(message.includes(secret), false);
    assert.match(message, /REDACTED/u);
  });
});
