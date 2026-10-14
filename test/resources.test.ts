import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { InvalidRequestError, MyAdion, type PayPayment } from '../src/index.js'
import { FakeApi } from './fake-server.js'

const api = new FakeApi()
beforeAll(() => api.start())
afterAll(() => api.stop())
beforeEach(() => api.reset())

function client(): MyAdion {
  return new MyAdion({ clientId: 'test_client', clientSecret: 'test_secret', baseUrl: `${api.url}/api`, retryBaseDelay: 0 })
}

describe('pay.sessions', () => {
  it('creates and retrieves a session', async () => {
    const myadion = client()
    const session = await myadion.pay.sessions.create({
      amount_cents: 4990,
      description: 'Order 4521',
      reference: 'ORDER-4521',
      metadata: { order_id: '4521' },
      success_url: 'https://shop.example.com/orders/4521/thanks',
    })
    expect(myadion.lastResponse?.status).toBe(201)
    expect(session.object).toBe('pay.session')
    expect(session.id).toMatch(/^pay_sess_/)
    expect(session.metadata.order_id).toBe('4521')
    expect(session.livemode).toBe(false)
    expect(await myadion.pay.sessions.retrieve(session.id)).toEqual(session)
  })

  it('returns the same session for the same idempotency key', async () => {
    const myadion = client()
    const params = { amount_cents: 1500, description: 'Order 7', success_url: 'https://shop.example.com/thanks' }
    const first = await myadion.pay.sessions.create(params, { idempotencyKey: 'order-7' })
    const second = await myadion.pay.sessions.create(params, { idempotencyKey: 'order-7' })
    expect(second.id).toBe(first.id)
    expect(myadion.lastResponse?.status).toBe(200)
    await expect(myadion.pay.sessions.create({ ...params, amount_cents: 9900 }, { idempotencyKey: 'order-7' })).rejects.toMatchObject({ status: 409, code: 'conflict' })
  })

  it('encodes ids in paths', async () => {
    await expect(client().pay.sessions.retrieve('../../auth/token')).rejects.toBeInstanceOf(InvalidRequestError)
    expect(api.log[1]?.path).toBe('/api/v1/pay/sessions/..%2F..%2Fauth%2Ftoken')
    expect(() => client().pay.sessions.retrieve('')).toThrow(TypeError)
  })
})

describe('pay.payments', () => {
  it('awaits one page', async () => {
    const page = await client().pay.payments.list({ per_page: 2 })
    expect(page.data).toHaveLength(2)
    expect(page.currentPage).toBe(1)
    expect(page.lastPage).toBe(3)
    expect(page.total).toBe(5)
    expect(page.hasMore).toBe(true)
    const next = await page.nextPage()
    expect(next?.currentPage).toBe(2)
  })

  it('iterates every page lazily with for await', async () => {
    const ids: string[] = []
    for await (const payment of client().pay.payments.list({ per_page: 2 })) {
      ids.push(payment.id)
    }
    expect(new Set(ids).size).toBe(5)
    expect(api.calls('/api/v1/pay/payments').map((r) => r.query)).toEqual([
      { per_page: '2' },
      { per_page: '2', page: '2' },
      { per_page: '2', page: '3' },
    ])
  })

  it('collects into an array, with a limit', async () => {
    const all: PayPayment[] = await client().pay.payments.list({ per_page: 2 }).toArray({ limit: 3 })
    expect(all).toHaveLength(3)
  })

  it('retrieves and refunds a payment', async () => {
    const myadion = client()
    const refund = await myadion.pay.refunds.create('pay_pmt_Test00000002', { amount_cents: 500, reason: 'Missing item' })
    expect(refund.object).toBe('pay.refund')
    expect(refund.payment?.status).toBe('partially_refunded')
    expect(api.calls('/api/v1/pay/payments/pay_pmt_Test00000002/refunds')[0]?.headers['idempotency-key']).toBeUndefined()

    const payment = await myadion.pay.payments.retrieve('pay_pmt_Test00000002')
    expect(payment.refunded_cents).toBe(500)
    expect(payment.refunds?.[0]?.reason).toBe('Missing item')
  })
})

describe('pay.webhookEndpoints', () => {
  it('manages the endpoints of a Pay account', async () => {
    const myadion = client()
    const account = 'pay_acct_TestAccount01'
    const created = await myadion.pay.webhookEndpoints.create(account, {
      url: 'https://shop.example.com/webhooks/adion-pay',
      events: ['payment.succeeded', 'refund.succeeded'],
    })
    expect(created.secret).toMatch(/^whsec_/)

    const list = await myadion.pay.webhookEndpoints.list(account)
    expect(list.data).toHaveLength(1)
    expect(list.hasMore).toBe(false)
    expect((list.raw.event_types as { code: string }[])[0]?.code).toBe('payment.succeeded')

    expect((await myadion.pay.webhookEndpoints.update(account, created.id, { enabled: false })).enabled).toBe(false)
    expect((await myadion.pay.webhookEndpoints.rotateSecret(account, created.id)).secret).not.toBe(created.secret)
    expect((await myadion.pay.webhookEndpoints.delete(account, created.id)).deleted).toBe(true)
    expect((await myadion.pay.webhookEndpoints.list(account)).data).toHaveLength(0)
  })
})

describe('sms', () => {
  it('sends and reads an SMS', async () => {
    const myadion = client()
    const batch = await myadion.sms.send({ service_id: 'service_AbCdEf123456', to: ['+33612345678', '+33698765432'], message: 'Your code: 482913', type: 'transactional' })
    expect(myadion.lastResponse?.status).toBe(202)
    expect(batch.messages).toHaveLength(2)
    const message = await myadion.sms.retrieve(batch.messages[0]?.id ?? '')
    expect(message.status).toBe('delivered')
  })
})
