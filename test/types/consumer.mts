import { Outbox, OutboxConnectionError, verifyWebhook, type BatchMessage, type Message, type MessageSummary, type Suppression, type WebhookEvent } from '@getoutbox/sdk';

const outbox = new Outbox({ apiKey: 'key' });
export const sent = outbox.send({ from: 'a@x.com', to: ['b@x.com'], cc: 'c@x.com', subject: 's', text: 't' });
export const event: Promise<WebhookEvent> = verifyWebhook('{}', new Headers(), 'whsec_x');
export const isTimeout = (e: unknown) => e instanceof OutboxConnectionError && e.code === 'timeout';

const base = { from: 'a@x.com', to: 'b@x.com' };
export const valid: Message[] = [
  { ...base, subject: 's', html: '<p>h</p>' },
  { ...base, subject: 's', text: 't' },
  { ...base, subject: 's', html: '<p>h</p>', text: 't' },
  { ...base, template: 'welcome', data: { name: 'Ada' } },
];
export const batch: BatchMessage[] = [{ ...base, template: 'welcome', idempotencyKey: 'k' }];

// @ts-expect-error no content
export const noContent: Message = { ...base };
// @ts-expect-error no subject
export const noSubject: Message = { ...base, html: '<p>h</p>' };
// @ts-expect-error subject without a body
export const noBody: Message = { ...base, subject: 's' };
// @ts-expect-error template content comes from the template
export const templateAndHtml: Message = { ...base, template: 'welcome', html: '<p>h</p>' };
// @ts-expect-error template content comes from the template
export const templateAndSubject: Message = { ...base, template: 'welcome', subject: 's' };
// @ts-expect-error data only applies to templates
export const dataWithoutTemplate: Message = { ...base, subject: 's', text: 't', data: { a: 1 } };

export async function walk(): Promise<[MessageSummary[], Suppression[], string | null]> {
  const all: MessageSummary[] = [];
  for await (const m of outbox.iterateMessages({ status: 'bounced', to: 'ada' })) all.push(m);
  const suppressed = await outbox.listSuppressions({ limit: 10 });
  const page = await outbox.listMessagesPage({ limit: 200 });
  await outbox.cancelMessage(all[0].id);
  await outbox.addSuppression('ada@example.com');
  await outbox.removeSuppression('ada@example.com');
  return [all, suppressed, page.next];
}
