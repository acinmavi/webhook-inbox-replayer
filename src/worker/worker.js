function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createWorker(options) {
  const {
    store,
    handlers,
    logger,
    pollIntervalMs,
    concurrency,
    batchSize,
    maxAttempts,
    baseRetryDelayMs
  } = options;

  let running = false;
  let loopPromise = null;
  const activeKeys = new Set();
  const activeTasks = new Set();

  function nextBackoffMs(attemptCount) {
    return baseRetryDelayMs * Math.pow(2, Math.max(0, attemptCount - 1));
  }

  async function processEvent(event) {
    const handler = handlers[event.eventType];
    if (!handler) {
      store.markFailed(event.id, event.attemptCount + 1, `No handler registered for ${event.eventType}`);
      return;
    }

    const incremented = store.incrementAttempts(event.id);
    try {
      await handler({
        ...event,
        attemptCount: incremented.attemptCount
      });

      store.markSucceeded(event.id);
      logger.info("event_succeeded", {
        eventId: event.id,
        resourceKey: event.resourceKey,
        eventType: event.eventType
      });
    } catch (error) {
      const attemptCount = incremented.attemptCount;
      const lastError = error && error.message ? error.message : String(error);

      if (error && error.retryable && attemptCount < maxAttempts) {
        const availableAt = new Date(Date.now() + nextBackoffMs(attemptCount)).toISOString();
        store.markRetryable(event.id, attemptCount, lastError, availableAt);
        logger.warn("event_retry_scheduled", {
          eventId: event.id,
          resourceKey: event.resourceKey,
          eventType: event.eventType,
          attemptCount,
          availableAt,
          lastError
        });
        return;
      }

      store.markFailed(event.id, attemptCount, lastError);
      logger.error("event_failed", {
        eventId: event.id,
        resourceKey: event.resourceKey,
        eventType: event.eventType,
        attemptCount,
        lastError
      });
    }
  }

  function launchEvent(event) {
    activeKeys.add(event.resourceKey);

    const task = processEvent(event)
      .catch((error) => {
        logger.error("worker_unhandled_error", {
          eventId: event.id,
          resourceKey: event.resourceKey,
          lastError: error.message
        });
      })
      .finally(() => {
        activeKeys.delete(event.resourceKey);
        activeTasks.delete(task);
      });

    activeTasks.add(task);
  }

  async function tick() {
    const capacity = Math.max(0, concurrency - activeTasks.size);
    if (capacity === 0) {
      return;
    }

    const candidates = store.listPartitionReady(batchSize);
    for (const event of candidates) {
      if (activeTasks.size >= concurrency) {
        break;
      }

      if (activeKeys.has(event.resourceKey)) {
        continue;
      }

      const claimed = store.claimEvent(event.id);
      if (!claimed) {
        continue;
      }

      launchEvent(claimed);
    }
  }

  async function loop() {
    while (running) {
      await tick();
      await sleep(pollIntervalMs);
    }
  }

  return {
    async start() {
      if (running) {
        return;
      }

      running = true;
      loopPromise = loop();
    },
    async stop() {
      running = false;
      if (loopPromise) {
        await loopPromise;
      }
      await Promise.allSettled([...activeTasks]);
    },
    async runTick() {
      await tick();
      await Promise.allSettled([...activeTasks]);
    }
  };
}

module.exports = {
  createWorker
};
