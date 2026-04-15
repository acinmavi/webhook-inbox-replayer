const test = require("node:test");
const assert = require("node:assert/strict");
const { createStore } = require("../src/inbox/store");
const { createIdempotencyLayer } = require("../src/inbox/idempotency");
const { createHandlers } = require("../src/handlers");
const { createWorker } = require("../src/worker/worker");
const { createReplayService } = require("../src/replay/replay-service");
const { createTempDbPath } = require("./helpers");

function createRuntime(name) {
  const store = createStore({ dbPath: createTempDbPath(name) });
  const handlers = createHandlers({
    store,
    idempotency: createIdempotencyLayer(store)
  });
  const logger = {
    info() {},
    warn() {},
    error() {}
  };
  const worker = createWorker({
    store,
    handlers,
    logger,
    pollIntervalMs: 5,
    concurrency: 4,
    batchSize: 16,
    maxAttempts: 3,
    baseRetryDelayMs: 1
  });
  const replayService = createReplayService({ store, logger });

  return { store, worker, replayService };
}

test("worker processes an event and materializes the projection", async () => {
  const { store, worker } = createRuntime("worker-success");
  store.insertEvent({
    id: "evt-success",
    provider: "demo",
    eventType: "customer.updated",
    resourceKey: "customer-1",
    dedupeKey: "dedupe-success",
    payload: { email: "user@example.com", tier: "pro", changeNumber: 1 }
  });

  await worker.runTick();

  const event = store.getEvent("evt-success");
  const projection = store.getProjection("customer-1");

  assert.equal(event.status, "succeeded");
  assert.equal(event.attemptCount, 1);
  assert.equal(projection.email, "user@example.com");
  assert.equal(projection.version, 1);

  store.close();
});

test("duplicate deliveries do not repeat side effects", async () => {
  const { store, worker } = createRuntime("worker-dup");
  store.insertEvent({
    id: "evt-dup-1",
    provider: "demo",
    eventType: "customer.updated",
    resourceKey: "customer-dup",
    dedupeKey: "same-dedupe",
    payload: { email: "dup@example.com", tier: "plus", changeNumber: 1 }
  });
  store.insertEvent({
    id: "evt-dup-2",
    provider: "demo",
    eventType: "customer.updated",
    resourceKey: "customer-dup",
    dedupeKey: "same-dedupe",
    payload: { email: "dup@example.com", tier: "plus", changeNumber: 1 }
  });

  await worker.runTick();
  await worker.runTick();

  const projection = store.getProjection("customer-dup");

  assert.equal(projection.version, 1);
  assert.equal(store.getEvent("evt-dup-1").status, "succeeded");
  assert.equal(store.getEvent("evt-dup-2").status, "succeeded");

  store.close();
});

test("retryable failures become failed after max attempts and replay makes them processable again", async () => {
  const { store, worker, replayService } = createRuntime("worker-retry");
  store.insertEvent({
    id: "evt-fail",
    provider: "demo",
    eventType: "customer.updated",
    resourceKey: "customer-fail",
    dedupeKey: "dedupe-fail",
    payload: { email: "fail@example.com", tier: "team", failMode: "untilReplay" }
  });

  await worker.runTick();
  await new Promise((resolve) => setTimeout(resolve, 2));
  await worker.runTick();
  await new Promise((resolve) => setTimeout(resolve, 2));
  await worker.runTick();

  let failed = store.getEvent("evt-fail");
  assert.equal(failed.status, "failed");
  assert.equal(failed.attemptCount, 3);

  replayService.replayById("evt-fail");
  await new Promise((resolve) => setTimeout(resolve, 2));
  await worker.runTick();

  failed = store.getEvent("evt-fail");
  const projection = store.getProjection("customer-fail");

  assert.equal(failed.status, "succeeded");
  assert.equal(projection.version, 1);

  store.close();
});

test("same-key events remain ordered while different keys can proceed", async () => {
  const { store, worker } = createRuntime("worker-ordered");
  store.insertEvent({
    id: "evt-1",
    provider: "demo",
    eventType: "customer.updated",
    resourceKey: "customer-ordered",
    dedupeKey: "ordered-1",
    payload: { email: "first@example.com", tier: "starter", changeNumber: 1 }
  });
  store.insertEvent({
    id: "evt-2",
    provider: "demo",
    eventType: "customer.updated",
    resourceKey: "customer-ordered",
    dedupeKey: "ordered-2",
    payload: { email: "second@example.com", tier: "growth", changeNumber: 2 }
  });
  store.insertEvent({
    id: "evt-3",
    provider: "demo",
    eventType: "customer.updated",
    resourceKey: "customer-other",
    dedupeKey: "other-1",
    payload: { email: "other@example.com", tier: "basic", changeNumber: 1 }
  });

  await worker.runTick();

  assert.equal(store.getEvent("evt-1").status, "succeeded");
  assert.equal(store.getEvent("evt-2").status, "pending");
  assert.equal(store.getEvent("evt-3").status, "succeeded");

  await worker.runTick();

  const projection = store.getProjection("customer-ordered");
  assert.equal(store.getEvent("evt-2").status, "succeeded");
  assert.equal(projection.lastChangeNumber, 2);

  store.close();
});
