const test = require("node:test");
const assert = require("node:assert/strict");
const { createApplication } = require("../src/app");
const { createTempDbPath, waitFor } = require("./helpers");

async function startRuntime(name) {
  const runtime = createApplication({
    dbPath: createTempDbPath(name),
    worker: {
      pollIntervalMs: 10,
      concurrency: 4,
      batchSize: 16,
      maxAttempts: 3,
      baseRetryDelayMs: 5
    },
    logger: {
      info() {},
      warn() {},
      error() {}
    }
  });

  await runtime.start();
  const server = runtime.app.listen(0);
  const address = server.address();

  return {
    runtime,
    baseUrl: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await runtime.stop();
    }
  };
}

test("webhook endpoint acknowledges fast and processing happens asynchronously", async () => {
  const app = await startRuntime("http-success");

  const response = await fetch(`${app.baseUrl}/webhooks/demo`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      type: "customer.updated",
      resourceKey: "customer-http",
      dedupeKey: "evt-http",
      payload: { email: "http@example.com", tier: "team", changeNumber: 1 }
    })
  });

  const body = await response.json();
  assert.equal(response.status, 202);
  assert.equal(body.status, "pending");

  await waitFor(() => {
    const event = app.runtime.store.getEvent(body.eventId);
    return event && event.status === "succeeded" ? event : null;
  });

  const projection = app.runtime.store.getProjection("customer-http");
  assert.equal(projection.version, 1);

  await app.close();
});

test("webhook endpoint rejects invalid payloads", async () => {
  const app = await startRuntime("http-invalid");

  const response = await fetch(`${app.baseUrl}/webhooks/demo`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      resourceKey: "missing-type",
      payload: {}
    })
  });

  assert.equal(response.status, 400);

  await app.close();
});
