import { Outbox, OutboxConnectionError, verifyWebhook, type WebhookEvent } from '@getoutbox/sdk';

const outbox = new Outbox({ apiKey: 'key' });
export const sent = outbox.send({ from: 'a@x.com', to: ['b@x.com'], cc: 'c@x.com', text: 't' });
export const event: Promise<WebhookEvent> = verifyWebhook('{}', new Headers(), 'whsec_x');
export const isTimeout = (e: unknown) => e instanceof OutboxConnectionError && e.code === 'timeout';
