# Changelog

## 0.4.0

Requires the matching API release for paging, `cancelMessage` and suppression paging.

**Breaking (types only; runtime behaviour is unchanged):**
- `Message` is now a union. Content is either `subject` plus `html` and/or `text`, or `template` (with optional `data`). Messages with no content, a subject without a body, or a template mixed with `subject`/`html`/`text` no longer compile; the API rejected the first two and silently ignored the inline content in the third.
- `BatchMessage` is a type alias instead of an interface, so `interface X extends Message` no longer works; use `type X = Message & { … }`.

**Added:**
- Message paging: `listMessagesPage()` returns `{ messages, next }`, `iterateMessages()` walks every page, and all three list methods accept `to` (recipient contains) and `after`.
- `cancelMessage(id)` stops a queued message. Throws `not_cancellable` once sending has started; repeat calls succeed, so it is retried like other safe requests.
- Suppressions: `listSuppressions()`, `listSuppressionsPage()`, `iterateSuppressions()`, `addSuppression(email)` and `removeSuppression(email)` (manual suppressions only; not retried automatically). Need a full-access key.
- `ErrorCode` includes `not_cancellable`.

## 0.3.1

- A 2xx response with an empty or non-JSON body is retried with the same idempotency key instead of failing straight away; if it persists, `OutboxApiError` has code `invalid_response`.
- Errors carry the request's `idempotencyKey`, including the one `send()` generates, so a manual retry cannot duplicate the message.
- Timeouts and network failures after the last retry throw `OutboxConnectionError` (`code`: `timeout` or `connection_error`, original error as `cause`) instead of a raw `TypeError` or `DOMException`. Your own `signal` still rethrows its reason.
- `Retry-After` given as an HTTP date is honoured; `OutboxApiError.retryAfterMs` exposes the hint.
- Tests for these cases and for the CommonJS and ESM type declarations. The publish workflow pins npm to an exact version.

## 0.3.0

- `to` accepts a list; new `cc` and `bcc`. Each recipient gets its own message id, returned in `result.recipients`. Requires the matching API release.
- `attachments` (base64 string or raw bytes, up to 10 files / 10 MB, inline images via `contentId`), custom `headers`, and `metadata` returned by `getMessage()` and in webhooks.
- `OutboxApiError.code` (stable, typed `ErrorCode`) and `OutboxApiError.requestId`. Batch item errors include `code`.
- `verifyWebhook(rawBody, headers, secret)` checks Standard Webhooks signatures (constant-time, 5-minute tolerance) and returns a typed event. Throws `WebhookVerificationError`.

## 0.2.0

- `replyTo` and `toName` message fields (requires the matching API release).
- Automatic retries for timeouts, network errors, 429 and 5xx (`maxRetries`, default 2), honouring `Retry-After`. `send()` generates an idempotency key when none is given, so retries cannot duplicate a message.
- `sendBatch()` for up to 100 messages, and `listMessages()`.
- `apiKey` falls back to `OUTBOX_API_KEY`; `baseUrl` falls back to `OUTBOX_BASE_URL`, then `https://outboxstack.app`.
- Per-request `signal` for cancellation. `User-Agent: outbox-node/<version>` header.
- `OutboxApiError.body` holds the parsed error response. `OutboxError` is the base class for SDK errors.
- `getMessage()` return type now matches the API (`MessageDetail`); the never-populated `events` field was removed.
- Requires Node.js 20.3+ (`AbortSignal.any`).

## 0.1.1

- Initial public release: `send()`, `getMessage()`, idempotency keys, 10s timeout.
