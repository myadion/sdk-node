# MyAdion Node.js library

The official Node.js library for the [Adion Cloud](https://myadion.com) API: take card payments with **Adion Pay**, send **SMS**, and call any other route of the API.

[Version française](README.fr.md)

- Node.js 18 or later, no dependency (built-in `fetch` and `crypto`)
- TypeScript types included, ES modules and CommonJS
- Gets and renews its access token by itself (OAuth `client_credentials`)
- Retries rate-limited and failed calls safely, with an automatic `Idempotency-Key` where the API accepts one
- Typed errors, with per-field validation messages
- Webhook signature verification
- Lazy pagination with `for await`

## Installation

```bash
npm install @myadion/sdk
```

## Credentials

In the customer area, open **My account › Applications** and create a **server** application with the scopes you need:

| Scope | For |
| --- | --- |
| `pay.session.write` | creating payment sessions |
| `pay.payment.read` | reading sessions and payments |
| `pay.refund.write` | refunding |
| `pay.webhook.manage` | managing webhook endpoints |
| `sms.message.send` | sending SMS |
| `sms.service.read` | reading the status of an SMS |

Keep the client id and the secret on your server, in environment variables. Never ship them to a browser or a mobile app.

## Usage

```ts
import { MyAdion } from '@myadion/sdk'
// or: const { MyAdion } = require('@myadion/sdk')

const myadion = new MyAdion({
  clientId: process.env.MYADION_CLIENT_ID,
  clientSecret: process.env.MYADION_CLIENT_SECRET,
  // project: 'project_AbCdEf123456', // when the application spans several projects
})

const session = await myadion.pay.sessions.create(
  {
    amount_cents: 4990, // €49.90, VAT included
    description: 'Order 4521',
    reference: 'ORDER-4521',
    metadata: { order_id: '4521' },
    customer_email: 'buyer@example.com',
    success_url: 'https://shop.example.com/orders/4521/thanks',
    cancel_url: 'https://shop.example.com/cart',
  },
  { idempotencyKey: 'order-4521' },
)

res.redirect(303, session.url)
```

Paid, the buyer comes back to `success_url?session_id=pay_sess_…` (or `{SESSION_ID}` in your URL is replaced). That return proves nothing: wait for the `payment.succeeded` webhook, or read the session again.

#### Embedded payment form

To keep the buyer on your page, create the session with `ui_mode: 'embedded'`. It has no `url`, but a `client_secret` of its own that your page hands to Adion's script; the card form lives in an iframe served by `pay.adioncloud.com`, so card data never touches your page. `return_url` replaces `success_url` and `cancel_url`. Declare the origin of your page first (client space › Pay account › Integration tab).

```ts
const session = await myadion.pay.sessions.create({
  amount_cents: 4990,
  description: 'Order 4521',
  reference: 'ORDER-4521',
  ui_mode: 'embedded',
  return_url: 'https://shop.example.com/orders/4521/thanks',
})
res.json({ clientSecret: session.client_secret })
```

```html
<div id="payment"></div>
<script src="https://pay.adioncloud.com/v1/adion-pay.js"></script>
<script type="module">
  const { clientSecret } = await (await fetch('/checkout/session', { method: 'POST' })).json()
  const checkout = await AdionPay().initEmbeddedCheckout({ clientSecret, onComplete: () => location.assign('/orders/4521/thanks') })
  checkout.mount('#payment')
</script>
```

The `client_secret` only opens this session, and expires with it. As with the redirect, `onComplete` proves nothing: the `payment.succeeded` webhook does.


### Adion Pay

```ts
// Sessions
await myadion.pay.sessions.create({ … })
await myadion.pay.sessions.retrieve('pay_sess_AbCdEf123456')

// Payments, most recent first: await one page…
const page = await myadion.pay.payments.list({ status: 'succeeded', per_page: 50 })
page.data, page.hasMore, await page.nextPage()

// …or walk every page lazily
for await (const payment of myadion.pay.payments.list({ status: 'succeeded' })) {
  console.log(payment.id, payment.amount_cents)
}
const payment = await myadion.pay.payments.retrieve('pay_pmt_AbCdEf123456') // with its refunds

// Refunds: without amount_cents, everything left is refunded
await myadion.pay.refunds.create('pay_pmt_AbCdEf123456', { amount_cents: 1000, reason: 'Missing item' })

// Webhook endpoints of a Pay account
const endpoint = await myadion.pay.webhookEndpoints.create('pay_acct_AbCdEf123456', {
  url: 'https://shop.example.com/webhooks/adion-pay',
  events: ['payment.succeeded', 'payment.failed', 'refund.succeeded'],
})
endpoint.secret // whsec_…, shown only once: store it now
await myadion.pay.webhookEndpoints.list('pay_acct_AbCdEf123456')
await myadion.pay.webhookEndpoints.update('pay_acct_AbCdEf123456', endpoint.id, { enabled: false })
await myadion.pay.webhookEndpoints.rotateSecret('pay_acct_AbCdEf123456', endpoint.id)
await myadion.pay.webhookEndpoints.deliveries('pay_acct_AbCdEf123456', endpoint.id, { detail: true })
await myadion.pay.webhookEndpoints.resendDelivery('pay_acct_AbCdEf123456', endpoint.id, 'pay_dlv_AbCdEf123456')
await myadion.pay.webhookEndpoints.delete('pay_acct_AbCdEf123456', endpoint.id)
```

### SMS

```ts
const batch = await myadion.sms.send({
  service_id: 'service_AbCdEf123456',
  to: ['+33612345678', '+33698765432'],
  message: 'Your code: 482913',
  type: 'transactional',
})
const message = await myadion.sms.retrieve(batch.messages[0].id)
message.status // queued, sent, delivered or failed
```

### Any other route

Every route of the [API reference](https://adion-api.eu) can be called with the same authentication, retries and errors:

```ts
const accounts = await myadion.request('GET', '/account/pay')
await myadion.request('POST', '/some/route', { field: 'value' }, { project: 'project_AbCdEf123456' })

for await (const item of myadion.requestCollection('GET', '/v1/pay/payments', { per_page: 100 })) {
  // …
}
```

`myadion.lastResponse` gives the status and headers of the last call (201 for a new session, 200 when an idempotency key returned an existing one).

## Webhooks

Each delivery is signed in the `Adion-Signature` header. Verify it on the **raw** body:

```ts
import express from 'express'
import { MyAdion, SignatureVerificationError } from '@myadion/sdk'

app.post('/webhooks/adion-pay', express.raw({ type: 'application/json' }), (req, res) => {
  let event
  try {
    event = MyAdion.webhooks.constructEvent(req.body, req.get('Adion-Signature'), process.env.MYADION_WEBHOOK_SECRET)
  } catch (error) {
    return res.sendStatus(400)
  }

  if (event.type === 'payment.succeeded') {
    const payment = event.data.object
    // mark the order payment.reference as paid
  }
  res.sendStatus(204)
})
```

`constructEvent()` compares signatures in constant time and refuses a signature older (or newer) than five minutes; the fourth argument changes that tolerance, in seconds. On failure it throws `SignatureVerificationError`: answer 400. It needs no credentials, so `MyAdion.webhooks` works without a client.

Answer 2xx quickly and do the long work afterwards. A delivery that fails is retried for three days, so the same event can arrive twice: use `event.id` to handle it once.

Events: `payment.succeeded`, `payment.failed`, `refund.succeeded`, `dispute.opened`, `dispute.closed`, `session.expired`.

To test your handler, `MyAdion.webhooks.generateTestHeaderString({ payload, secret })` builds a valid header.

## Errors

| Error | When |
| --- | --- |
| `AuthenticationError` | 401: wrong credentials, revoked application |
| `PermissionError` | 403: missing scope, project outside the application |
| `InvalidRequestError` | 400, 402, 404, 409, 422: the request as written is refused |
| `RateLimitError` | 429, after the retries |
| `ApiError` | 5xx, or an answer that cannot be read |
| `ApiConnectionError` | the API could not be reached, or the call timed out |
| `SignatureVerificationError` | a webhook signature is wrong |

They all extend `MyAdionError`, with `status`, `code` (`validation_error`, `not_found`…), `details`, `headers` and `rawBody`.

```ts
import { InvalidRequestError } from '@myadion/sdk'

try {
  await myadion.pay.sessions.create({ … })
} catch (error) {
  if (error instanceof InvalidRequestError) {
    error.errors // { success_url: ['…must be an https address.'] }
    error.fieldErrors('success_url')
  }
}
```

## Retries and idempotency

The library retries a call up to `maxRetries` times (2 by default), with exponential backoff and jitter, honouring `Retry-After` when the API sends it:

- on **429**, always: the API refused the call before doing anything;
- on **5xx**, timeouts and network errors, only when a retry is harmless: `GET`, `PUT`, `DELETE`, and `POST /v1/pay/sessions`, which carries an `Idempotency-Key` (generated if you give none, identical across retries).

A refund or an SMS is never retried after a server error or a lost connection: read the payment, or the message, to know where it stands.

Give your own key, one per order, to make **your** retries safe too: `{ idempotencyKey: 'order-4521' }`. The same key with the same body returns the same session; with another body, the API answers 409.

The API accepts 120 Adion Pay calls per minute and per application.

## Configuration

| Option | Default | |
| --- | --- | --- |
| `clientId`, `clientSecret` | | the server application |
| `accessToken` | | a token you obtained yourself, instead of the credentials (never renewed) |
| `scopes` | all of the application's | array or space-separated string |
| `project` | | sent as `x-api-project`; required when the application spans several projects |
| `organization` | | sent as `x-api-org` |
| `baseUrl` | `https://adion-api.eu/api` | |
| `timeout` | 30000 | per attempt, in milliseconds |
| `maxRetries` | 2 | |
| `retryBaseDelay` | 500 | milliseconds |
| `fetch` | global `fetch` | any compatible implementation |
| `appInfo` | | `{ name: 'MyPlugin', version: '1.2.0', url: '…' }`, added to the User-Agent |

Every method also takes a last `options` argument: `project`, `organization`, `idempotencyKey`, `headers`, `maxRetries`, `timeout`, `signal`.

## Test mode

There is no test key and no test switch. Use the credentials of an application created in a **test organization**: the library works the same, and objects and events carry `livemode: false`. Going live means swapping the credentials (and the webhook secret), nothing else.

## Development

```bash
npm install
npm test     # typecheck, ESLint, Vitest, build, then load the ESM and CJS bundles
```

The tests run against a fake API served locally (`test/fake-server.ts`); they never call the real API.

## Links

- Guides: [docs.myadion.com](https://docs.myadion.com/api/bibliotheques)
- API reference: [adion-api.eu](https://adion-api.eu)
- PHP library: [myadion/sdk-php](https://github.com/myadion/sdk-php)
- Security: see [SECURITY.md](SECURITY.md)

## License

MIT, see [LICENSE](LICENSE).
