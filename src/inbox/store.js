const Database = require("better-sqlite3");

function nowIso() {
  return new Date().toISOString();
}

function createStore(options) {
  const db = new Database(options.dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");

  db.exec(`
    CREATE TABLE IF NOT EXISTS inbox_events (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      event_type TEXT NOT NULL,
      resource_key TEXT NOT NULL,
      dedupe_key TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending', 'processing', 'succeeded', 'failed')),
      attempt_count INTEGER NOT NULL DEFAULT 0,
      payload TEXT NOT NULL,
      last_error TEXT,
      received_at TEXT NOT NULL,
      processed_at TEXT,
      available_at TEXT NOT NULL,
      locked_at TEXT,
      replay_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_inbox_status_available
      ON inbox_events(status, available_at, received_at, id);

    CREATE INDEX IF NOT EXISTS idx_inbox_resource_status
      ON inbox_events(resource_key, status, received_at, id);

    CREATE TABLE IF NOT EXISTS processed_effects (
      effect_key TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      resource_key TEXT NOT NULL,
      processed_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS customer_projections (
      resource_key TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      tier TEXT NOT NULL,
      last_change_number INTEGER NOT NULL DEFAULT 0,
      version INTEGER NOT NULL DEFAULT 0,
      last_event_id TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  const statements = {
    insertEvent: db.prepare(`
      INSERT INTO inbox_events (
        id, provider, event_type, resource_key, dedupe_key, status,
        attempt_count, payload, last_error, received_at, processed_at, available_at, locked_at, replay_count
      ) VALUES (
        @id, @provider, @eventType, @resourceKey, @dedupeKey, 'pending',
        0, @payload, NULL, @receivedAt, NULL, @availableAt, NULL, 0
      )
    `),
    listDuePending: db.prepare(`
      SELECT id, provider, event_type AS eventType, resource_key AS resourceKey,
             dedupe_key AS dedupeKey, status, attempt_count AS attemptCount, payload,
             last_error AS lastError, received_at AS receivedAt, processed_at AS processedAt,
             available_at AS availableAt, locked_at AS lockedAt, replay_count AS replayCount
      FROM inbox_events
      WHERE status = 'pending' AND available_at <= ?
      ORDER BY received_at ASC, id ASC
      LIMIT ?
    `),
    claimPending: db.prepare(`
      UPDATE inbox_events
      SET status = 'processing', locked_at = @lockedAt
      WHERE id = @id AND status = 'pending'
    `),
    markSucceeded: db.prepare(`
      UPDATE inbox_events
      SET status = 'succeeded',
          processed_at = @processedAt,
          last_error = NULL,
          locked_at = NULL
      WHERE id = @id
    `),
    markRetryable: db.prepare(`
      UPDATE inbox_events
      SET status = 'pending',
          attempt_count = @attemptCount,
          last_error = @lastError,
          available_at = @availableAt,
          locked_at = NULL
      WHERE id = @id
    `),
    markFailed: db.prepare(`
      UPDATE inbox_events
      SET status = 'failed',
          attempt_count = @attemptCount,
          last_error = @lastError,
          locked_at = NULL
      WHERE id = @id
    `),
    incrementAttempts: db.prepare(`
      UPDATE inbox_events
      SET attempt_count = attempt_count + 1
      WHERE id = ?
    `),
    getEvent: db.prepare(`
      SELECT id, provider, event_type AS eventType, resource_key AS resourceKey,
             dedupe_key AS dedupeKey, status, attempt_count AS attemptCount, payload,
             last_error AS lastError, received_at AS receivedAt, processed_at AS processedAt,
             available_at AS availableAt, locked_at AS lockedAt, replay_count AS replayCount
      FROM inbox_events
      WHERE id = ?
    `),
    listInbox: db.prepare(`
      SELECT id, provider, event_type AS eventType, resource_key AS resourceKey,
             dedupe_key AS dedupeKey, status, attempt_count AS attemptCount, payload,
             last_error AS lastError, received_at AS receivedAt, processed_at AS processedAt,
             available_at AS availableAt, locked_at AS lockedAt, replay_count AS replayCount
      FROM inbox_events
      ORDER BY received_at ASC, id ASC
    `),
    listFailed: db.prepare(`
      SELECT id, provider, event_type AS eventType, resource_key AS resourceKey,
             dedupe_key AS dedupeKey, status, attempt_count AS attemptCount, payload,
             last_error AS lastError, received_at AS receivedAt, processed_at AS processedAt,
             available_at AS availableAt, locked_at AS lockedAt, replay_count AS replayCount
      FROM inbox_events
      WHERE status = 'failed'
      ORDER BY received_at ASC, id ASC
    `),
    replayFailedById: db.prepare(`
      UPDATE inbox_events
      SET status = 'pending',
          attempt_count = 0,
          last_error = NULL,
          processed_at = NULL,
          locked_at = NULL,
          available_at = @availableAt,
          replay_count = replay_count + 1,
          payload = @payload
      WHERE status = 'failed' AND id = @id
    `),
    listProjections: db.prepare(`
      SELECT resource_key AS resourceKey, email, tier, last_change_number AS lastChangeNumber,
             version, last_event_id AS lastEventId, updated_at AS updatedAt
      FROM customer_projections
      ORDER BY resource_key ASC
    `),
    getProjection: db.prepare(`
      SELECT resource_key AS resourceKey, email, tier, last_change_number AS lastChangeNumber,
             version, last_event_id AS lastEventId, updated_at AS updatedAt
      FROM customer_projections
      WHERE resource_key = ?
    `),
    upsertProjection: db.prepare(`
      INSERT INTO customer_projections (
        resource_key, email, tier, last_change_number, version, last_event_id, updated_at
      ) VALUES (
        @resourceKey, @email, @tier, @changeNumber, 1, @eventId, @updatedAt
      )
      ON CONFLICT(resource_key) DO UPDATE SET
        email = excluded.email,
        tier = excluded.tier,
        last_change_number = excluded.last_change_number,
        version = customer_projections.version + 1,
        last_event_id = excluded.last_event_id,
        updated_at = excluded.updated_at
    `),
    getProcessedEffect: db.prepare(`
      SELECT effect_key AS effectKey, event_id AS eventId, resource_key AS resourceKey, processed_at AS processedAt
      FROM processed_effects
      WHERE effect_key = ?
    `),
    insertProcessedEffect: db.prepare(`
      INSERT INTO processed_effects(effect_key, event_id, resource_key, processed_at)
      VALUES (@effectKey, @eventId, @resourceKey, @processedAt)
    `)
  };

  function serializeEvent(event) {
    return {
      id: event.id,
      provider: event.provider,
      eventType: event.eventType,
      resourceKey: event.resourceKey,
      dedupeKey: event.dedupeKey,
      payload: JSON.stringify(event.payload),
      receivedAt: event.receivedAt || nowIso(),
      availableAt: event.availableAt || nowIso()
    };
  }

  function hydrateEvent(row) {
    if (!row) {
      return null;
    }

    return {
      ...row,
      payload: JSON.parse(row.payload)
    };
  }

  const claimEvent = db.transaction((id) => {
    const event = statements.getEvent.get(id);
    if (!event || event.status !== "pending") {
      return null;
    }

    const lockedAt = nowIso();
    const result = statements.claimPending.run({ id, lockedAt });
    if (result.changes !== 1) {
      return null;
    }

    return hydrateEvent(statements.getEvent.get(id));
  });

  const runIdempotentEffect = db.transaction((params, fn) => {
    const existing = statements.getProcessedEffect.get(params.effectKey);
    if (existing) {
      return {
        applied: false,
        existing
      };
    }

    const result = fn();
    statements.insertProcessedEffect.run({
      effectKey: params.effectKey,
      eventId: params.eventId,
      resourceKey: params.resourceKey,
      processedAt: nowIso()
    });

    return {
      applied: true,
      result
    };
  });

  return {
    close() {
      db.close();
    },
    insertEvent(event) {
      statements.insertEvent.run(serializeEvent(event));
      return this.getEvent(event.id);
    },
    getEvent(id) {
      return hydrateEvent(statements.getEvent.get(id));
    },
    listInbox() {
      return statements.listInbox.all().map(hydrateEvent);
    },
    listFailed() {
      return statements.listFailed.all().map(hydrateEvent);
    },
    listDuePending(limit, at = nowIso()) {
      return statements.listDuePending.all(at, limit).map(hydrateEvent);
    },
    listPartitionReady(limit, at = nowIso()) {
      const selected = [];
      const seenKeys = new Set();

      for (const event of this.listDuePending(limit, at)) {
        if (seenKeys.has(event.resourceKey)) {
          continue;
        }

        seenKeys.add(event.resourceKey);
        selected.push(event);
      }

      return selected;
    },
    claimEvent,
    incrementAttempts(id) {
      statements.incrementAttempts.run(id);
      return this.getEvent(id);
    },
    markSucceeded(id) {
      statements.markSucceeded.run({
        id,
        processedAt: nowIso()
      });
      return this.getEvent(id);
    },
    markRetryable(id, attemptCount, lastError, availableAt) {
      statements.markRetryable.run({
        id,
        attemptCount,
        lastError,
        availableAt
      });
      return this.getEvent(id);
    },
    markFailed(id, attemptCount, lastError) {
      statements.markFailed.run({
        id,
        attemptCount,
        lastError
      });
      return this.getEvent(id);
    },
    replayFailedById(id, payloadTransform) {
      const event = this.getEvent(id);
      if (!event || event.status !== "failed") {
        return null;
      }

      const nextPayload = payloadTransform ? payloadTransform(event.payload) : event.payload;
      statements.replayFailedById.run({
        id,
        availableAt: nowIso(),
        payload: JSON.stringify(nextPayload)
      });
      return this.getEvent(id);
    },
    replayAllFailed(payloadTransform) {
      const failed = this.listFailed();
      for (const event of failed) {
        const nextPayload = payloadTransform ? payloadTransform(event.payload) : event.payload;
        statements.replayFailedById.run({
          id: event.id,
          availableAt: nowIso(),
          payload: JSON.stringify(nextPayload)
        });
      }
      return failed.map((event) => this.getEvent(event.id));
    },
    runIdempotentEffect,
    getProcessedEffect(effectKey) {
      return statements.getProcessedEffect.get(effectKey) || null;
    },
    getProjection(resourceKey) {
      return statements.getProjection.get(resourceKey) || null;
    },
    listProjections() {
      return statements.listProjections.all();
    },
    saveProjection(projection) {
      statements.upsertProjection.run({
        resourceKey: projection.resourceKey,
        email: projection.email,
        tier: projection.tier,
        changeNumber: projection.changeNumber || 0,
        eventId: projection.eventId,
        updatedAt: nowIso()
      });
      return this.getProjection(projection.resourceKey);
    }
  };
}

module.exports = {
  createStore
};
