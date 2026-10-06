# @getoutbox/sdk

Outbox Stack SDK for server-side transactional email. Node.js 20.3+, ESM and CommonJS, zero runtime dependencies.

```sh
npm install @getoutbox/sdk
```

Before sending: create an account, enable managed sending (or connect a provider), verify your sender domain, then create an API key in **Developers**. Store it in your backend's secret manager as `OUTBOX_API_KEY`.

## Send

```ts
import { Outbox, OutboxApiError } from '@getoutbox/sdk';

const outbox = new Outbox(); // reads OUTBOX_API_KEY; base URL defaults to https://outboxstack.app

const { id } = await outbox.send({
  from: 'accounts@your-verified-domain.com',
  fromName: 'Your app',
  to: 'ada@example.com',
  toName: 'Ada Obi',
  replyTo: 'support@your-verified-domain.com',
  subject: 'Reset your password',
  text: `Reset your password: ${resetUrl}`,
}, { idempotencyKey: `password-reset:${resetRequestId}` });
```

CommonJS: `const { Outbox } = require('@getoutbox/sdk');`

| Field | |
|---|---|
| `to`, `from` | Required. `from` must be on a verified domain. |
| `toName`, `fromName` | Display names. |
| `replyTo` | Where replies go, e.g. a support inbox. |
| `subject` + `html` and/or `text` | Message content. A text part is generated from `html` when omitted. |
| `template` + `data` | Template id or slug, in place of subject and body. Missing variables return 422. |

`send()` resolves when the message is **queued**, not delivered. Track it with `getMessage()` or signed webhooks.

## Batch, status and history

```ts
const batch = await outbox.sendBatch(users.map((u) => ({
  from: 'news@your-verified-domain.com', to: u.email, toName: u.name,
  template: 'weekly-digest', data: { name: u.name },
  idempotencyKey: `digest:2026-41:${u.id}`,
})));
for (const r of batch.results) if ('error' in r) console.warn(r.index, r.error);

const message = await outbox.getMessage(id);            // status, attempts, last_error, …
const bounced = await outbox.listMessages({ status: 'bounced', limit: 100 });
```

`sendBatch` takes 1–100 messages. Items succeed or fail independently, so the call resolves even when some items fail.

## Retries and idempotency

Timeouts, network errors, 429 and 5xx are retried up to `maxRetries` times (default 2), using `Retry-After` when the API sends it and jittered exponential backoff otherwise. 4xx errors are never retried.

A retry never sends twice. `send()` always carries an idempotency key and generates one when you don't pass one. Pass your own key, derived from the event that triggered the email, to stay safe across process restarts and job re-runs as well. `sendBatch` retries only when **every** item has an `idempotencyKey`.

## Errors

```ts
try {
  await outbox.send(message);
} catch (e) {
  if (e instanceof OutboxApiError) console.error(e.status, e.message, e.body);
  else throw e; // network error or timeout after retries, or AbortError
}
```

| Status | Meaning |
|---|---|
| 400 | Invalid message. |
| 401 / 403 | Bad key or no access. |
| 402 | Account limit or credits exhausted. |
| 404 | Template not found. |
| 422 | Unverified sender domain, no transactional route, or missing template data. |

## Options

```ts
new Outbox({
  apiKey: '…',          // default: process.env.OUTBOX_API_KEY
  baseUrl: '…',         // default: process.env.OUTBOX_BASE_URL, then https://outboxstack.app
  timeoutMs: 10_000,    // per attempt
  maxRetries: 2,
  fetch: customFetch,
});
```

Every method also accepts `{ signal }` (an `AbortSignal`) to cancel the request and any pending retries.

Keep API keys on the server. Never ship them in browser or mobile bundles. Escape untrusted values before putting them in `html`.

## Development and releases

```sh
npm ci
npm test
npm pack --dry-run
```

Source: `src/index.ts`. Build outputs ESM, CommonJS, declarations and source maps to `dist/`. Releases go through `.github/workflows/publish.yml` (npm trusted publishing) after the version is bumped.
