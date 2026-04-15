function createIdempotencyLayer(store) {
  return {
    runOnce({ effectKey, eventId, resourceKey }, fn) {
      const recorded = store.runIdempotentEffect({
        effectKey,
        eventId,
        resourceKey
      }, fn);

      if (!recorded.applied) {
        return {
          skipped: true,
          existing: recorded.existing
        };
      }

      return {
        skipped: false,
        result: recorded.result
      };
    }
  };
}

module.exports = {
  createIdempotencyLayer
};
