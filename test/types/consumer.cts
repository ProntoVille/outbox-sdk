// Resolves through the package's "require" export to dist/index.d.cts.
import sdk = require('@getoutbox/sdk');

const outbox = new sdk.Outbox({ apiKey: 'key' });
export const sent: Promise<sdk.SendResult> = outbox.send({ from: 'a@x.com', to: 'b@x.com', text: 't' }, { idempotencyKey: 'k' });

export function describe(e: unknown): string | null {
  if (e instanceof sdk.OutboxConnectionError) return e.code;
  if (e instanceof sdk.OutboxApiError) return `${e.code} ${e.requestId} ${e.retryAfterMs}`;
  return e instanceof sdk.OutboxError ? e.idempotencyKey : null;
}
