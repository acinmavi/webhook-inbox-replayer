# webhook-inbox-replayer

`webhook-inbox-replayer` is a compact Node.js reference implementation of the durable webhook inbox pattern: accept fast, persist first, process asynchronously, protect side effects with idempotency, recover with replay, and keep ordering for the same logical resource key without introducing infrastructure theater.

## The Problem

Webhook producers deliver at least once, on their schedule, with their retry behavior. If a receiver does synchronous business work inline with the HTTP request, it couples acknowledgment latency to downstream health and turns transient failures into data loss risk.

This repo isolates the pattern into a small, runnable backend system:

- persist every accepted webhook durably before any business logic
- acknowledge quickly with `202 Accepted`
- process inbox records in a worker loop
- retry transient failures with explicit backoff
- fail visibly after max attempts
- replay failures intentionally from a CLI
- preserve ordering per `resourceKey` while still processing unrelated keys in parallel

## Why Synchronous Webhook Handling Is Unsafe

Inline processing is attractive because it is simple to sketch and dangerous to operate:

- request timeouts can cause the provider to retry while your handler may have partially executed
- transient database or API failures can make the whole delivery disappear if you never durably recorded it
- duplicates are common, so side effects must be idempotent even when the inbound request looks identical
- a hot resource can require strict ordering while the overall system still needs throughput

The inbox pattern addresses that by splitting ingress durability from downstream execution.

## Architecture

The repository runs as a single Node.js process for local simplicity, but preserves the production shape:

- `Webhook Receiver`: Express endpoint that validates the minimal webhook envelope and inserts a row into SQLite before returning `202`
- `Inbox Store`: SQLite-backed tables for inbox events, processed side effects, and a demo projection
- `Worker`: poll-and-claim loop that only takes the earliest pending item per `resourceKey`
- `Idempotency Layer`: processed effect registry keyed by effect name + dedupe key
- `Replay CLI`: resets failed inbox records back to `pending`
- `Demo Handler`: `customer.updated` projection updater with deterministic failure injection

![System Overview](/docs/images/system-overview.png)

## Event Lifecycle

1. Provider calls `POST /webhooks/:provider`.
2. Receiver validates a minimal envelope: `type`, `resourceKey`, `payload`.
3. Receiver stores raw JSON, envelope metadata, timestamps, and dedupe key in `inbox_events`.
4. Receiver returns `202 Accepted` immediately.
5. Worker polls `pending` rows whose `availableAt` is due.
6. Worker claims at most one event per `resourceKey`, marks it `processing`, and executes the handler.
7. Handler runs through the idempotency registry so duplicate deliveries do not repeat the side effect.
8. Success moves the row to `succeeded`; retryable failure returns it to `pending` with backoff; permanent failure moves it to `failed`.

![Event Lifecycle](/docs/images/event-lifecycle-sequence.png)

## Retry And Replay Semantics

Retries are automatic for transient failures:

- each processing attempt increments `attemptCount`
- retryable failures are rescheduled with exponential backoff
- once `maxAttempts` is exceeded, the event is marked `failed`

Replay is intentionally manual:

- `node scripts/replay-failed.js --id <eventId>` requeues one failed event
- `node scripts/replay-failed.js --all` requeues every failed event
- replay resets the event to `pending`, clears error metadata, and prints the affected rows

This keeps recovery explicit and auditable instead of silently retrying forever.

![Retry And Replay](/docs/images/retry-replay-state-machine.png)

## Idempotency Strategy

Each inbox record has a `dedupeKey`. The demo handler wraps its side effect in a processed-effects registry:

- effect key: `customer.updated:<dedupeKey>`
- registry table: `processed_effects`
- duplicate delivery: worker may still pick it up, but the side effect is skipped safely

The side effect itself updates a `customer_projections` table and increments a version counter. Sending the same webhook twice keeps the projection version stable, which makes duplicate suppression visible.

## Per-Key Ordering Strategy

Ordering is preserved by only claiming the oldest pending event for each `resourceKey` in a polling cycle. Different keys can run in parallel because the worker may claim multiple keys at once, but a key already in flight is skipped until its active event completes.

That means:

- `customer-123` events are processed in order
- `customer-123` and `customer-456` can process concurrently
- the implementation stays understandable because it avoids queue brokers and cross-process leases

![Partitioned Worker Flow](/docs/images/partitioned-worker-flow.png)

## Failure Modes

This repo is intentionally honest about what can still go wrong:

- crash after inbox insert but before ack: provider retries, but dedupe and durable storage make this survivable
- crash after claim but before completion: events can remain `processing`; this demo keeps the lease simple and is optimized for local clarity rather than distributed recovery
- non-idempotent downstream systems: out of scope, but the pattern shows where to put effect registries
- unbounded inbox growth: out of scope, no retention or archival policy is implemented

## Run Locally

### Prerequisites

- Node.js `>= 20`
- Java installed locally for PlantUML rendering

### Install

```bash
npm install
```

### Start The Server

```bash
npm start
```

The server listens on `http://localhost:3000` by default and creates SQLite state in `data/webhook-inbox-replayer.db`.

### Useful Commands

```bash
npm test
npm run seed
npm run demo:duplicates
npm run replay -- --all
```

## Demo Scenarios

### 1. Normal Flow Succeeds

```bash
curl -X POST http://localhost:3000/webhooks/demo \
  -H "Content-Type: application/json" \
  -d "{\"type\":\"customer.updated\",\"resourceKey\":\"customer-100\",\"dedupeKey\":\"evt-100\",\"payload\":{\"email\":\"one@example.com\",\"tier\":\"pro\"}}"
```

Inspect status:

```bash
curl http://localhost:3000/admin/inbox
curl http://localhost:3000/admin/projections
```

### 2. Duplicate Delivery Does Not Repeat Side Effects

```bash
npm run demo:duplicates
```

The duplicate inbox rows will both be recorded, but the projection version for `customer-dup` only increments once.

### 3. Worker Failure Leaves A Failed Event

```bash
curl -X POST http://localhost:3000/webhooks/demo \
  -H "Content-Type: application/json" \
  -d "{\"type\":\"customer.updated\",\"resourceKey\":\"customer-fail\",\"dedupeKey\":\"evt-fail\",\"payload\":{\"email\":\"fail@example.com\",\"tier\":\"team\",\"failMode\":\"untilReplay\"}}"
```

After max attempts, the inbox row lands in `failed` with `lastError`.

### 4. Replay Moves The Failed Event Back Through Processing

```bash
npm run replay -- --all
```

Replay strips the demo failure flag from the payload, resets failed rows to `pending`, and the worker processes them successfully.

### 5. Same-Key Events Stay Ordered

```bash
curl -X POST http://localhost:3000/webhooks/demo \
  -H "Content-Type: application/json" \
  -d "{\"type\":\"customer.updated\",\"resourceKey\":\"customer-ordered\",\"dedupeKey\":\"evt-ordered-1\",\"payload\":{\"email\":\"first@example.com\",\"tier\":\"starter\",\"changeNumber\":1}}"

curl -X POST http://localhost:3000/webhooks/demo \
  -H "Content-Type: application/json" \
  -d "{\"type\":\"customer.updated\",\"resourceKey\":\"customer-ordered\",\"dedupeKey\":\"evt-ordered-2\",\"payload\":{\"email\":\"second@example.com\",\"tier\":\"growth\",\"changeNumber\":2}}"
```

The projection ends at change `2`, and the worker never processes change `2` before change `1`.

## Trade-Offs And Intentional Omissions

This repo is deliberately small and omits several production concerns:

- no authentication or webhook signature verification
- no distributed worker coordination across multiple hosts
- no dead-letter queue beyond failed-row replay
- no retention management, metrics backend, or tracing system
- no ORM and no framework-heavy layering

Those omissions are intentional. The goal is to make the durable inbox pattern legible in 10-15 minutes without hiding it behind infrastructure or abstractions.
