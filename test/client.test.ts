import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  ApiConnectionError,
  ApiError,
  AuthenticationError,
  InvalidRequestError,
  MyAdion,
  PermissionError,
  RateLimitError,
  type MyAdionConfig,
} from '../src/index.js'
import { FakeApi } from './fake-server.js'

const api = new FakeApi()
beforeAll(() => api.start())
afterAll(() => api.stop())
beforeEach(() => api.reset())

function client(config: MyAdionConfig = {}): MyAdion {
  return new MyAdion({ clientId: 'test_client', clientSecret: 'test_secret', baseUrl: `${api.url}/api`, retryBaseDelay: 0, timeout: 5000, ...config })
}

interface Echo {
  method: string
  query: Record<string, string>
  body: Record<string, unknown>
  project: string | null
}

describe('configuration', () => {
  it('needs credentials', () => {
    expect(() => new MyAdion({ clientId: 'only_an_id' })).toThrow(TypeError)
  })

  it('refuses unknown options', () => {
    expect(() => new MyAdion({ clientId: 'a', clientSecret: 'b', apiKey: 'c' } as MyAdionConfig)).toThrow(/apiKey/)
  })
})

describe('authentication', () => {
  it('fetches one token and reuses it, even for concurrent calls', async () => {
    const myadion = client({ scopes: ['pay.session.write', 'pay.payment.read'] })
    await Promise.all([myadion.request('GET', '/echo'), myadion.request('GET', '/echo'), myadion.request('GET', '/echo')])

    expect(api.calls('/api/auth/token')).toHaveLength(1)
    const form = new URLSearchParams(api.calls('/api/auth/token')[0]?.body)
    expect(form.get('grant_type')).toBe('client_credentials')
    expect(form.get('scope')).toBe('pay.session.write pay.payment.read')
    const echo = api.calls('/api/echo')
    expect(echo[0]?.headers.authorization).toMatch(/^Bearer tok_1_/)
    expect(echo[0]?.headers['user-agent']).toMatch(/^myadion-node\/0\.2\.0 node\//)
  })

  it('renews a token close to expiry', async () => {
    api.tokenExpiresIn = 30
    const myadion = client()
    await myadion.request('GET', '/echo')
    await myadion.request('GET', '/echo')
    expect(api.calls('/api/auth/token')).toHaveLength(2)
  })

  it('renews a revoked token once', async () => {
    const myadion = client()
    await myadion.request('GET', '/echo')
    api.tokens.clear()
    await myadion.request('GET', '/echo')
    expect(api.log.map((r) => r.path)).toEqual(['/api/auth/token', '/api/echo', '/api/echo', '/api/auth/token', '/api/echo'])
  })

  it('raises an AuthenticationError on wrong credentials', async () => {
    const error = await client({ clientSecret: 'wrong' }).request('GET', '/echo').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AuthenticationError)
    expect(error).toMatchObject({ status: 401, code: 'unauthorized', message: 'Le secret client est invalide.' })
  })

  it('sends a static token as is and never renews it', async () => {
    const myadion = new MyAdion({ accessToken: 'tok_static', baseUrl: `${api.url}/api` })
    await expect(myadion.request('GET', '/echo')).rejects.toBeInstanceOf(AuthenticationError)
    expect(api.log).toHaveLength(1)
    expect(api.log[0]?.headers.authorization).toBe('Bearer tok_static')
  })
})

describe('requests', () => {
  it('sends project and organization headers', async () => {
    const myadion = client({ project: 'project_AbCdEf123456', organization: 'org_AbCdEf123456' })
    const echo = await myadion.request<Echo>('GET', '/echo')
    expect(echo.project).toBe('project_AbCdEf123456')
    await myadion.request('GET', '/echo', {}, { project: 'project_ZyXwVu987654' })
    await myadion.request('GET', '/echo', {}, { project: null })
    const calls = api.calls('/api/echo')
    expect(calls[0]?.headers['x-api-org']).toBe('org_AbCdEf123456')
    expect(calls[1]?.headers['x-api-project']).toBe('project_ZyXwVu987654')
    expect(calls[2]?.headers['x-api-project']).toBeUndefined()
  })

  it('encodes the query string and the JSON body', async () => {
    const myadion = client()
    const get = await myadion.request<Echo>('GET', 'echo', { detail: true, page: 2, skip: undefined, none: null })
    expect(get.query).toEqual({ detail: '1', page: '2' })
    const post = await myadion.request<Echo>('POST', '/echo', { amount_cents: 4990, metadata: { order_id: '4521' }, description: 'Café' })
    expect(post.body).toEqual({ amount_cents: 4990, metadata: { order_id: '4521' }, description: 'Café' })
    expect(api.calls('/api/echo')[1]?.headers['content-type']).toBe('application/json')
    expect(myadion.lastResponse?.status).toBe(200)
  })
})

describe('retries', () => {
  it('retries a GET after server errors', async () => {
    api.fail.push({ method: 'GET', path: '/api/v1/pay/payments', status: 503, times: 2 })
    const page = await client().pay.payments.list()
    expect(page.data).toHaveLength(5)
    expect(api.calls('/api/v1/pay/payments')).toHaveLength(3)
  })

  it('stops at maxRetries', async () => {
    api.fail.push({ method: 'GET', path: '/api/v1/pay/payments', status: 500, times: 5 })
    const error = await client({ maxRetries: 1 }).pay.payments.list().then(() => null, (e: unknown) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ status: 500, code: 'server_error' })
    expect(api.calls('/api/v1/pay/payments')).toHaveLength(2)
  })

  it('retries a session with the same Idempotency-Key', async () => {
    api.fail.push({ method: 'POST', path: '/api/v1/pay/sessions', status: 502, times: 1 })
    const session = await client().pay.sessions.create({ amount_cents: 4990, description: 'Order 4521', success_url: 'https://shop.example.com/thanks' })
    expect(session.status).toBe('open')
    const calls = api.calls('/api/v1/pay/sessions')
    expect(calls).toHaveLength(2)
    expect(calls[0]?.headers['idempotency-key']).toMatch(/^myadion-node-/)
    expect(calls[1]?.headers['idempotency-key']).toBe(calls[0]?.headers['idempotency-key'])
  })

  it('creates an embedded session with its own client_secret and no url', async () => {
    const session = await client().pay.sessions.create({
      amount_cents: 4990,
      description: 'Order 4521',
      ui_mode: 'embedded',
      return_url: 'https://shop.example.com/orders/4521/thanks',
    })
    expect(session.ui_mode).toBe('embedded')
    expect(session.url).toBeNull()
    expect(session.return_url).toBe('https://shop.example.com/orders/4521/thanks')
    expect(session.client_secret).toMatch(/^[A-Za-z0-9]{10}_secret_[A-Za-z0-9]{32}$/)
  })

  it('never retries a refund after a server error', async () => {
    api.fail.push({ method: 'POST', path: '/api/v1/pay/payments/pay_pmt_Test00000001/refunds', status: 500, times: 1 })
    await expect(client().pay.refunds.create('pay_pmt_Test00000001')).rejects.toBeInstanceOf(ApiError)
    expect(api.calls('/api/v1/pay/payments/pay_pmt_Test00000001/refunds')).toHaveLength(1)
  })

  it('retries a 429, even for an SMS, honouring Retry-After', async () => {
    api.fail.push({ method: 'POST', path: '/api/v1/sms', status: 429, times: 1, headers: { 'Retry-After': '0' } })
    const batch = await client().sms.send({ service_id: 'service_AbCdEf123456', to: '+33612345678', message: 'Hi', type: 'transactional' })
    expect(batch.messages).toHaveLength(1)
    expect(api.calls('/api/v1/sms')).toHaveLength(2)
    expect(api.calls('/api/v1/sms')[0]?.headers['idempotency-key']).toBeUndefined()
  })

  it('raises a RateLimitError when 429 persists', async () => {
    api.fail.push({ method: 'GET', path: '/api/v1/pay/payments', status: 429, times: 9 })
    await expect(client().pay.payments.list()).rejects.toBeInstanceOf(RateLimitError)
  })

  it('times out and retries a slow GET', async () => {
    api.fail.push({ method: 'GET', path: '/api/echo', status: 200, times: 1, delayMs: 400 })
    const echo = await client({ timeout: 150 }).request<Echo>('GET', '/echo')
    expect(echo.method).toBe('GET')
    expect(api.calls('/api/echo')).toHaveLength(2)
  })

  it('raises an ApiConnectionError when the API cannot be reached', async () => {
    await expect(client({ baseUrl: 'http://127.0.0.1:1/api', maxRetries: 1 }).request('GET', '/echo')).rejects.toBeInstanceOf(ApiConnectionError)
  })
})

describe('errors', () => {
  it('gives validation errors per field', async () => {
    const error = await client()
      .pay.sessions.create({ amount_cents: 50, description: 'x', success_url: 'http://insecure.example.com' })
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(InvalidRequestError)
    const invalid = error as InvalidRequestError
    expect(invalid.status).toBe(422)
    expect(invalid.code).toBe('validation_error')
    expect(Object.keys(invalid.errors)).toEqual(['amount_cents', 'success_url'])
    expect(invalid.fieldErrors('success_url')).toEqual(['Le champ success url doit être une adresse https.'])
    expect(invalid.fieldErrors('description')).toEqual([])
  })

  it('maps status codes to typed errors', async () => {
    const myadion = client()
    await expect(myadion.request('GET', '/forbidden')).rejects.toBeInstanceOf(PermissionError)
    await expect(myadion.pay.sessions.retrieve('pay_sess_Unknown00000')).rejects.toMatchObject({ status: 404, code: 'not_found', name: 'InvalidRequestError' })
  })
})
