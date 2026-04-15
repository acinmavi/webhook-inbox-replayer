function sanitizeReplayPayload(payload) {
  if (!payload || typeof payload !== "object") {
    return payload;
  }

  const next = { ...payload };
  if (next.failMode === "untilReplay") {
    delete next.failMode;
  }

  return next;
}

function createReplayService({ store, logger }) {
  return {
    replayById(id) {
      const event = store.replayFailedById(id, sanitizeReplayPayload);
      if (event) {
        logger.info("event_replayed", {
          eventId: event.id,
          resourceKey: event.resourceKey,
          replayCount: event.replayCount
        });
      }
      return event;
    },
    replayAll() {
      const events = store.replayAllFailed(sanitizeReplayPayload);
      if (events.length > 0) {
        logger.info("events_replayed", {
          count: events.length
        });
      }
      return events;
    }
  };
}

module.exports = {
  createReplayService
};
