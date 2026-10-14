/*
 * A fake Adion Cloud API for the test suite, on 127.0.0.1. It mimics the
 * contract of the real API (paths, status codes, error bodies, idempotency,
 * pagination) and never talks to the network.
 */
import { createHash, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export const CLIENT_ID = 'test_client'
export const CLIENT_SECRET = 'test_secret'

export interface Received {
  method: string
  path: string
  query: Record<string, string>
  headers: Record<string, string>
  body: string
}

export interface Failure {
  method?: string
  path: string
  status: number
  times: number
  headers?: Record<string, string>
  /** Wait this long before answering (to trigger client timeouts). */
  delayMs?: number
}

type Json = Record<string, unknown>

export class FakeApi {
  server: Server
  url = ''
  log: Received[] = []
  fail: Failure[] = []
  tokens = new Set<string>()
  tokenCount = 0
  tokenExpiresIn = 3600
  sessions = new Map<string, Json>()
  idempotency = new Map<string, { hash: string; id: string }>()
  payments: Json[] = []
  webhooks = new Map<string, Json>()

  constructor() {
    this.reset()
    this.server = createServer((req, res) => {
      this.#handle(req, res).catch((error: unknown) => {
        res.writeHead(500).end(String(error))
      })
    })
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve))
    const { port } = this.server.address() as AddressInfo
    this.url = `http://127.0.0.1:${port}`
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections?.()
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }

  reset(): void {
    this.log = []
    this.fail = []
    this.tokens.clear()
    this.tokenCount = 0
    this.tokenExpiresIn = 3600
    this.sessions.clear()
    this.idempotency.clear()
    this.webhooks.clear()
    this.payments = [1, 2, 3, 4, 5].map((i) => payment(`pay_pmt_Test0000000${i}`, 1000 * i))
  }

  calls(path: string): Received[] {
    return this.log.filter((r) => r.path === path)
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const raw = Buffer.concat(chunks).toString('utf8')
    const url = new URL(req.url ?? '/', 'http://localhost')
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v.join(', ') : (v ?? '')
    const method = req.method ?? 'GET'
    const path = url.pathname
    this.log.push({ method, path, query: Object.fromEntries(url.searchParams), headers, body: raw })
    let body: Json = {}
    try {
      const parsed: unknown = raw ? JSON.parse(raw) : {}
      if (parsed && typeof parsed === 'object') body = parsed as Json
    } catch {
      body = {}
    }

    const send = (status: number, payload?: unknown, extra: Record<string, string> = {}): void => {
      res.writeHead(status, { 'Content-Type': 'application/json', ...extra })
      res.end(payload === undefined ? '' : JSON.stringify(payload))
    }

    const failure = this.fail.find((f) => f.path === path && (f.method ?? method) === method && f.times > 0)
    if (failure) {
      failure.times--
      if (failure.delayMs) await new Promise((r) => setTimeout(r, failure.delayMs))
      send(failure.status, errorBody(failure.status, 'Injected failure.'), failure.headers)
      return
    }

    if (method === 'POST' && path === '/api/auth/token') {
      const form = new URLSearchParams(raw)
      if (form.get('client_id') !== CLIENT_ID || form.get('client_secret') !== CLIENT_SECRET) {
        send(401, errorBody(401, 'Le secret client est invalide.'))
        return
      }
      this.tokenCount++
      const token = `tok_${this.tokenCount}_${randomBytes(8).toString('hex')}`
      this.tokens.add(token)
      send(200, { token_type: 'Bearer', access_token: token, expires_in: this.tokenExpiresIn, scope: form.get('scope') ?? '' })
      return
    }

    const auth = headers.authorization ?? ''
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
    if (!this.tokens.has(token)) {
      send(401, errorBody(401, 'Access token invalide.'))
      return
    }
    const project = headers['x-api-project']

    if (path === '/api/forbidden') return send(403, errorBody(403, 'Accès refusé.'))
    if (path === '/api/echo') return send(200, { method, query: Object.fromEntries(url.searchParams), body, project: project ?? null })

    if (method === 'POST' && path === '/api/v1/pay/sessions') {
      const errors: Record<string, string[]> = {}
      const amount = body.amount_cents
      if (typeof amount !== 'number' || amount < 100 || amount > 99_999_900) errors.amount_cents = ['Le montant va d’un euro à 999 999 €.']
      if (typeof body.description !== 'string' || body.description === '') errors.description = ['Le champ description est obligatoire.']
      const embedded = body.ui_mode === 'embedded'
      if (embedded && body.success_url !== undefined) errors.success_url = ['Le champ success url est interdit quand ui mode vaut embedded.']
      else if (!embedded && (typeof body.success_url !== 'string' || !body.success_url.startsWith('https://'))) errors.success_url = ['Le champ success url doit être une adresse https.']
      if (!embedded && body.return_url !== undefined) errors.return_url = ['Le champ return url est interdit sauf si ui mode vaut embedded.']
      const first = Object.values(errors)[0]
      if (first) return send(422, errorBody(422, first[0] ?? '', errors))
      const key = (headers['idempotency-key'] ?? '').trim()
      const hash = createHash('sha256').update(JSON.stringify(body)).digest('hex')
      const previous = key ? this.idempotency.get(key) : undefined
      if (previous) {
        if (previous.hash !== hash) return send(409, errorBody(409, 'Cette clé d’idempotence a déjà servi pour une autre demande.'))
        return send(200, this.sessions.get(previous.id))
      }
      const id = randomId('pay_sess_')
      const session = {
        id, object: 'pay.session', url: embedded ? null : `https://pay.example.test/${id.slice(9)}`,
        ui_mode: embedded ? 'embedded' : 'hosted', status: 'open',
        amount_cents: amount, currency: 'eur', description: body.description, reference: body.reference ?? null,
        metadata: body.metadata ?? {}, customer_email: body.customer_email ?? null, success_url: body.success_url ?? null,
        cancel_url: body.cancel_url ?? null, return_url: body.return_url ?? null, pay_account_id: 'pay_acct_TestAccount01', payment_id: null,
        payment_status: null, livemode: false, expires_at: '2026-10-15T10:00:00+00:00', completed_at: null,
        created_at: '2026-10-14T10:00:00+00:00',
        ...(embedded ? { client_secret: `${id.slice(9, 19)}_secret_${'A'.repeat(32)}` } : {}),
      }
      this.sessions.set(id, session)
      if (key) this.idempotency.set(key, { hash, id })
      return send(201, session)
    }

    let m = /^\/api\/v1\/pay\/sessions\/([^/]+)$/.exec(path)
    if (method === 'GET' && m) {
      const session = this.sessions.get(decodeURIComponent(m[1] ?? ''))
      return session ? send(200, session) : send(404, errorBody(404, 'Cette session de paiement est introuvable.'))
    }

    if (method === 'GET' && path === '/api/v1/pay/payments') {
      const perPage = Number(url.searchParams.get('per_page') ?? 25)
      const page = Math.max(1, Number(url.searchParams.get('page') ?? 1))
      const status = url.searchParams.get('status')
      const items = this.payments.filter((p) => !status || p.status === status)
      const last = Math.max(1, Math.ceil(items.length / perPage))
      const data = items.slice((page - 1) * perPage, page * perPage).map((p) => Object.fromEntries(Object.entries(p).filter(([k]) => k !== 'refunds')))
      return send(200, { data, meta: { current_page: page, per_page: perPage, total: items.length, last_page: last } })
    }

    m = /^\/api\/v1\/pay\/payments\/([^/]+)(\/refunds)?$/.exec(path)
    if (m) {
      const p = this.payments.find((x) => x.id === m?.[1])
      if (!p) return send(404, errorBody(404, 'Ce paiement est introuvable.'))
      if (method === 'GET' && !m[2]) return send(200, p)
      if (method === 'POST' && m[2]) {
        const left = (p.amount_cents as number) - (p.refunded_cents as number)
        const amount = typeof body.amount_cents === 'number' ? body.amount_cents : left
        if (amount < 1 || amount > left) return send(422, errorBody(422, 'Le montant est hors limites.', { amount_cents: ['Le montant est hors limites.'] }))
        p.refunded_cents = (p.refunded_cents as number) + amount
        p.status = p.refunded_cents === p.amount_cents ? 'refunded' : 'partially_refunded'
        const refund = { id: randomId('pay_rfd_'), object: 'pay.refund', payment_id: p.id, amount_cents: amount, currency: 'eur', status: 'succeeded', reason: body.reason ?? null, created_at: '2026-10-14T11:00:00+00:00' }
        ;(p.refunds as Json[]).push(refund)
        return send(201, { ...refund, payment: { id: p.id, object: 'pay.payment', status: p.status, amount_cents: p.amount_cents, refunded_cents: p.refunded_cents } })
      }
    }

    m = /^\/api\/account\/pay\/(pay_acct_[A-Za-z0-9]+)\/webhook(?:\/([^/]+))?(\/secret)?$/.exec(path)
    if (m) {
      const id = m[2] ?? ''
      if (!id && method === 'GET') return send(200, { data: [...this.webhooks.values()], event_types: [{ code: 'payment.succeeded', label: 'Paiement réussi' }] })
      if (!id && method === 'POST') {
        const wid = randomId('pay_whk_')
        const endpoint = { id: wid, url: body.url, description: body.description ?? null, events: body.events ?? [], enabled: body.enabled ?? true, secret_hint: 'whsec_…test', secret_rotated_at: null, created_at: '2026-10-14T10:00:00+00:00' }
        this.webhooks.set(wid, endpoint)
        return send(201, { ...endpoint, secret: `whsec_${randomBytes(16).toString('hex')}` })
      }
      const endpoint = this.webhooks.get(id)
      if (!endpoint) return send(404, errorBody(404, 'Cette adresse de webhook est introuvable.'))
      if (m[3] && method === 'POST') return send(200, { ...endpoint, secret: `whsec_${randomBytes(16).toString('hex')}` })
      if (method === 'PUT') {
        for (const k of ['url', 'description', 'events', 'enabled']) if (k in body) endpoint[k] = body[k]
        return send(200, endpoint)
      }
      if (method === 'DELETE') {
        this.webhooks.delete(id)
        return send(200, { deleted: true })
      }
      return send(200, { ...endpoint, deliveries: [] })
    }

    if (method === 'POST' && path === '/api/v1/sms') {
      const to = Array.isArray(body.to) ? (body.to as string[]) : [String(body.to ?? '')]
      const messages = to.map((n) => ({ id: randomId('sms_msg_'), service_id: body.service_id, to: n, type: body.type, status: 'queued', segments: 1, credits: 1 }))
      return send(202, { batch_id: randomId('sms_batch_'), credits: messages.length, balance: 100, messages, rejected: [] })
    }
    m = /^\/api\/v1\/sms\/([^/]+)$/.exec(path)
    if (method === 'GET' && m) return send(200, { id: m[1], status: 'delivered' })

    send(404, errorBody(404, 'Route introuvable.'))
  }
}

function payment(id: string, amount: number): Json {
  return {
    id, object: 'pay.payment', status: 'succeeded', amount_cents: amount, fee_cents: 50, refunded_cents: 0,
    net_cents: amount - 50, currency: 'eur', reference: `ORDER-${amount}`, metadata: { order_id: String(amount) },
    session_id: null, link_id: null, pay_account_id: 'pay_acct_TestAccount01', customer_email: 'buyer@example.com',
    customer_name: 'Test Buyer', payment_method: 'Visa •••• 4242', disputed: false, failure_message: null,
    livemode: false, created_at: '2026-10-14T10:00:00+00:00', paid_at: '2026-10-14T10:00:05+00:00', refunds: [],
  }
}

function errorBody(status: number, message: string, details?: Record<string, string[]>): Json {
  const labels: Record<number, string> = { 400: 'bad_request', 401: 'unauthorized', 403: 'forbidden', 404: 'not_found', 409: 'conflict', 422: 'validation_error', 429: 'too_many_requests' }
  return { message, status, error: labels[status] ?? (status >= 500 ? 'server_error' : 'request_error'), ...(details ? { details } : {}) }
}

function randomId(prefix: string): string {
  return prefix + randomBytes(12).toString('base64').replace(/[+/=]/g, '').slice(0, 12)
}
