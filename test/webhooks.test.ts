import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { MyAdion, MyAdionError, SignatureVerificationError } from '../src/index.js'

const SECRET = 'whsec_test_secret_for_the_suite'
const PAYLOAD = '{"id":"pay_evt_AbCdEf123456","object":"event","type":"payment.succeeded","api_version":"2026-10-14","created":"2026-10-14T10:03:12+00:00","livemode":false,"pay_account_id":"pay_acct_AbCdEf123456","data":{"object":{"id":"pay_pmt_AbCdEf123456","object":"pay.payment","status":"succeeded","amount_cents":4990,"reference":"CMD-4521","metadata":{"order_id":"4521"},"customer_name":"Zoé"}}}'
const webhooks = MyAdion.webhooks
const now = (): number => Math.floor(Date.now() / 1000)

describe('webhooks.constructEvent', () => {
  it('gives the event for a valid signature, from a string or a Buffer', () => {
    const header = webhooks.generateTestHeaderString({ payload: PAYLOAD, secret: SECRET })
    const event = webhooks.constructEvent<{ id: string; metadata: { order_id: string } }>(PAYLOAD, header, SECRET)
    expect(event.type).toBe('payment.succeeded')
    expect(event.data.object.metadata.order_id).toBe('4521')
    expect(webhooks.constructEvent(Buffer.from(PAYLOAD, 'utf8'), header, SECRET).id).toBe('pay_evt_AbCdEf123456')
  })

  it('is also available on a client instance', () => {
    const myadion = new MyAdion({ clientId: 'a', clientSecret: 'b' })
    const header = myadion.webhooks.generateTestHeaderString({ payload: PAYLOAD, secret: SECRET })
    expect(myadion.webhooks.constructEvent(PAYLOAD, header, SECRET).livemode).toBe(false)
  })

  it('matches the server algorithm', () => {
    const expected = createHmac('sha256', SECRET).update(`1760436000.${PAYLOAD}`).digest('hex')
    expect(webhooks.computeSignature(1760436000, PAYLOAD, SECRET)).toBe(expected)
    expect(webhooks.generateTestHeaderString({ payload: PAYLOAD, secret: SECRET, timestamp: 1760436000 })).toBe(`t=1760436000,v1=${expected}`)
  })

  it('refuses a wrong secret and a modified body', () => {
    const header = webhooks.generateTestHeaderString({ payload: PAYLOAD, secret: SECRET })
    expect(() => webhooks.constructEvent(PAYLOAD, header, 'whsec_other')).toThrow(SignatureVerificationError)
    expect(() => webhooks.constructEvent(PAYLOAD.replace('4990', '1'), header, SECRET)).toThrow(SignatureVerificationError)
  })

  it('refuses an old or future timestamp, unless the tolerance allows it', () => {
    for (const timestamp of [now() - 301, now() + 301]) {
      const header = webhooks.generateTestHeaderString({ payload: PAYLOAD, secret: SECRET, timestamp })
      expect(() => webhooks.constructEvent(PAYLOAD, header, SECRET)).toThrow(/tolerance/)
    }
    const old = webhooks.generateTestHeaderString({ payload: PAYLOAD, secret: SECRET, timestamp: now() - 3600 })
    expect(webhooks.constructEvent(PAYLOAD, old, SECRET, 0).type).toBe('payment.succeeded')
    expect(webhooks.constructEvent(PAYLOAD, old, SECRET, 7200).type).toBe('payment.succeeded')
  })

  it('refuses malformed headers and a missing secret', () => {
    const valid = webhooks.generateTestHeaderString({ payload: PAYLOAD, secret: SECRET })
    const [t, v1] = valid.split(',') as [string, string]
    for (const header of ['', undefined, null, t, v1, `t=abc,${v1}`, 'garbage', `${t},v1=short`]) {
      expect(() => webhooks.constructEvent(PAYLOAD, header, SECRET)).toThrow(SignatureVerificationError)
    }
    expect(() => webhooks.constructEvent(PAYLOAD, valid, '')).toThrow(SignatureVerificationError)
  })

  it('accepts any of several signatures', () => {
    const valid = webhooks.generateTestHeaderString({ payload: PAYLOAD, secret: SECRET })
    const [t, v1] = valid.split(',') as [string, string]
    expect(webhooks.constructEvent(PAYLOAD, `${t},v1=${'0'.repeat(64)},${v1}`, SECRET).type).toBe('payment.succeeded')
  })

  it('refuses a payload that is not a JSON object', () => {
    const header = webhooks.generateTestHeaderString({ payload: 'not json', secret: SECRET })
    expect(() => webhooks.constructEvent('not json', header, SECRET)).toThrow(MyAdionError)
  })
})
