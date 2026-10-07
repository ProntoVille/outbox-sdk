# Changelog

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
