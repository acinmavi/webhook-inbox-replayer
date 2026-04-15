const crypto = require("crypto");
const express = require("express");
const { createStore } = require("./inbox/store");
const { createIdempotencyLayer } = require("./inbox/idempotency");
const { createHandlers } = require("./handlers");
const { createWorker } = require("./worker/worker");
const { createReplayService } = require("./replay/replay-service");
const defaultLogger = require("./utils/logger");

function validateEnvelope(body) {
  if (!body || typeof body !== "object") {
    return "Body must be a JSON object.";
  }
  if (!body.type || typeof body.type !== "string") {
    return "Field 'type' is required.";
  }
  if (!body.resourceKey || typeof body.resourceKey !== "string") {
    return "Field 'resourceKey' is required.";
  }
  if (body.payload === undefined) {
    return "Field 'payload' is required.";
  }

  return null;
}

function buildEvent(provider, body) {
  const payload = body.payload;
  return {
    id: crypto.randomUUID(),
    provider,
    eventType: body.type,
    resourceKey: body.resourceKey,
    dedupeKey: body.dedupeKey || `${provider}:${body.type}:${body.resourceKey}:${JSON.stringify(payload)}`,
    payload,
    receivedAt: new Date().toISOString(),
    availableAt: new Date().toISOString()
  };
}

function createApplication(options) {
  const logger = options.logger || defaultLogger;
  const store = options.store || createStore({ dbPath: options.dbPath });
  const idempotency = createIdempotencyLayer(store);
  const handlers = createHandlers({ store, idempotency });
  const worker = createWorker({
    store,
    handlers,
    logger,
    pollIntervalMs: options.worker.pollIntervalMs,
    concurrency: options.worker.concurrency,
    batchSize: options.worker.batchSize,
    maxAttempts: options.worker.maxAttempts,
    baseRetryDelayMs: options.worker.baseRetryDelayMs
  });
  const replayService = createReplayService({ store, logger });

  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (req, res) => {
    res.json({ ok: true });
  });

  app.post("/webhooks/:provider", (req, res) => {
    const provider = req.params.provider;
    const validationError = validateEnvelope(req.body);
    if (validationError) {
      res.status(400).json({ error: validationError });
      return;
    }

    const event = buildEvent(provider, req.body);
    const persisted = store.insertEvent(event);

    logger.info("webhook_ingested", {
      eventId: persisted.id,
      provider,
      eventType: persisted.eventType,
      resourceKey: persisted.resourceKey,
      dedupeKey: persisted.dedupeKey
    });

    res.status(202).json({
      accepted: true,
      eventId: persisted.id,
      status: persisted.status
    });
  });

  app.get("/admin/inbox", (req, res) => {
    res.json({ items: store.listInbox() });
  });

  app.get("/admin/projections", (req, res) => {
    res.json({ items: store.listProjections() });
  });

  app.post("/admin/worker/tick", async (req, res) => {
    await worker.runTick();
    res.json({ ok: true });
  });

  return {
    app,
    store,
    worker,
    replayService,
    async start() {
      await worker.start();
    },
    async stop() {
      await worker.stop();
      store.close();
    }
  };
}

module.exports = {
  createApplication
};
