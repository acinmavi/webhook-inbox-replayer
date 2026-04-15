function createRetryableError(message) {
  const error = new Error(message);
  error.retryable = true;
  return error;
}

function createCustomerUpdatedHandler({ store, idempotency }) {
  return async function handleCustomerUpdated(event) {
    const effectKey = `customer.updated:${event.dedupeKey}`;

    return idempotency.runOnce(
      {
        effectKey,
        eventId: event.id,
        resourceKey: event.resourceKey
      },
      () => {
        const payload = event.payload || {};

        if (payload.failMode === "always") {
          throw createRetryableError("Demo handler configured to fail on every attempt.");
        }

        if (payload.failMode === "untilReplay") {
          throw createRetryableError("Demo handler configured to fail until operator replay.");
        }

        store.saveProjection({
          resourceKey: event.resourceKey,
          email: payload.email || "unknown@example.com",
          tier: payload.tier || "free",
          changeNumber: payload.changeNumber || 0,
          eventId: event.id
        });

        return { applied: true };
      }
    );
  };
}

module.exports = {
  createCustomerUpdatedHandler
};
