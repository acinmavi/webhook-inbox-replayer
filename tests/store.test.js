const test = require("node:test");
const assert = require("node:assert/strict");
const { createStore } = require("../src/inbox/store");
const { createTempDbPath } = require("./helpers");

test("store persists inbox events and returns partition-ready events in per-key order", () => {
  const store = createStore({ dbPath: createTempDbPath("store") });

  store.insertEvent({
    id: "evt-1",
    provider: "demo",
    eventType: "customer.updated",
    resourceKey: "customer-a",
    dedupeKey: "dedupe-1",
    payload: { changeNumber: 1 }
  });
  store.insertEvent({
    id: "evt-2",
    provider: "demo",
    eventType: "customer.updated",
    resourceKey: "customer-a",
    dedupeKey: "dedupe-2",
    payload: { changeNumber: 2 }
  });
  store.insertEvent({
    id: "evt-3",
    provider: "demo",
    eventType: "customer.updated",
    resourceKey: "customer-b",
    dedupeKey: "dedupe-3",
    payload: { changeNumber: 1 }
  });

  const ready = store.listPartitionReady(10);

  assert.deepEqual(ready.map((item) => item.id), ["evt-1", "evt-3"]);

  store.close();
});

test("replay resets failed events to pending and increments replay count", () => {
  const store = createStore({ dbPath: createTempDbPath("replay") });

  store.insertEvent({
    id: "evt-failed",
    provider: "demo",
    eventType: "customer.updated",
    resourceKey: "customer-fail",
    dedupeKey: "dedupe-failed",
    payload: { failMode: "untilReplay" }
  });
  store.markFailed("evt-failed", 3, "boom");

  const replayed = store.replayFailedById("evt-failed", (payload) => {
    const next = { ...payload };
    delete next.failMode;
    return next;
  });

  assert.equal(replayed.status, "pending");
  assert.equal(replayed.attemptCount, 0);
  assert.equal(replayed.replayCount, 1);
  assert.equal(replayed.lastError, null);
  assert.equal(replayed.payload.failMode, undefined);

  store.close();
});
