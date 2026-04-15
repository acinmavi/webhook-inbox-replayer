const path = require("path");

function numberFromEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }

  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

module.exports = {
  port: numberFromEnv("PORT", 3000),
  dbPath: process.env.DB_PATH || path.join(process.cwd(), "data", "webhook-inbox-replayer.db"),
  worker: {
    pollIntervalMs: numberFromEnv("WORKER_POLL_INTERVAL_MS", 200),
    concurrency: numberFromEnv("WORKER_CONCURRENCY", 4),
    batchSize: numberFromEnv("WORKER_BATCH_SIZE", 16),
    maxAttempts: numberFromEnv("MAX_ATTEMPTS", 3),
    baseRetryDelayMs: numberFromEnv("BASE_RETRY_DELAY_MS", 250)
  }
};
