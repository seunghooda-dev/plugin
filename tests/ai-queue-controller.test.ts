/// <reference lib="dom" />
/// <reference lib="dom.iterable" />

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { AIQueueController } from "../src/ai-queue-controller";

describe("AIQueueController", () => {
  it("does not replace the executor of an already deduplicated active job", async () => {
    const controller = new AIQueueController();
    let firstCalls = 0;
    let secondCalls = 0;
    const first = controller.run("text", { id: 1 }, async () => {
      firstCalls += 1;
      return "first";
    });
    const second = controller.run("text", { id: 1 }, async () => {
      secondCalls += 1;
      return "second";
    });
    assert.equal(await first, "first");
    assert.equal(await second, "first");
    assert.equal(firstCalls, 1);
    assert.equal(secondCalls, 0);
  });
});
