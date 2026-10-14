/** Options accepted by the MyAdion constructor. */
export interface MyAdionConfig {
  /** The client id of a server application (My account › Applications). */
  clientId?: string | undefined
  /** Its secret. Keep it on your server. */
  clientSecret?: string | undefined
  /** A token you obtained yourself, instead of the credentials. Never renewed. */
  accessToken?: string | undefined
  /** Scopes asked for the token (array or space-separated). Default: all of the application's. */
  scopes?: string[] | string | undefined
  /** Sent as `x-api-project`. Required when the application spans several projects. */
  project?: string | undefined
  /** Sent as `x-api-org`. */
  organization?: string | undefined
  /** Default `https://adion-api.eu/api`. */
  baseUrl?: string | undefined
  /** Per attempt, in milliseconds. Default 30000. */
  timeout?: number | undefined
  /** Default 2. */
  maxRetries?: number | undefined
  /** First retry delay in milliseconds, doubled each time (with jitter). Default 500. */
  retryBaseDelay?: number | undefined
  /** A fetch implementation. Default: the global fetch of Node 18+. */
  fetch?: typeof fetch | undefined
  /** Added to the User-Agent: `{ name: 'MyPlugin', version: '1.2.0', url: '…' }`. */
  appInfo?: { name: string; version?: string; url?: string } | undefined
}

/** Options accepted by every call, as the last argument. */
export interface RequestOptions {
  /** Overrides the project of the client; `null` sends none. */
  project?: string | null | undefined
  /** Overrides the organization of the client; `null` sends none. */
  organization?: string | null | undefined
  /** Your own key, one per order: your retries become safe too. */
  idempotencyKey?: string | undefined
  headers?: Record<string, string> | undefined
  maxRetries?: number | undefined
  timeout?: number | undefined
  signal?: AbortSignal | undefined
}

export type Metadata = Record<string, string>

interface PaySessionBaseParams {
  /** Amount in cents, VAT included (100 to 99 999 900). */
  amount_cents: number
  /** What the buyer reads, 500 characters at most. */
  description: string
  currency?: 'eur' | null
  /** Your reference (order number), 120 characters at most. */
  reference?: string | null
  /** Up to 20 keys of 40 characters, text values of 500 characters. */
  metadata?: Metadata | null
  customer_email?: string | null
  /** ISO 8601, from 30 minutes to 7 days ahead. Default: 24 hours. */
  expires_at?: string | null
  pay_account_id?: string | null
}

/** The buyer pays on Adion's payment page (`url`), then returns to `success_url`. */
export interface PayHostedSessionCreateParams extends PaySessionBaseParams {
  ui_mode?: 'hosted' | null
  /** The https address the buyer returns to after paying. */
  success_url: string
  cancel_url?: string | null
}

/**
 * Embedded form: no redirect. The session comes back with its own
 * `client_secret`, that your page hands to https://pay.adioncloud.com/v1/adion-pay.js.
 * The form only shows on the origins declared on the Pay account.
 */
export interface PayEmbeddedSessionCreateParams extends PaySessionBaseParams {
  ui_mode: 'embedded'
  /** Where the buyer goes once paid (with `session_id`), if your page has no `onComplete`. */
  return_url?: string | null
}

export type PaySessionCreateParams = PayHostedSessionCreateParams | PayEmbeddedSessionCreateParams

export interface PaySession {
  id: string
  object: 'pay.session'
  /** The payment page; null for an embedded session. */
  url: string | null
  ui_mode: 'hosted' | 'embedded'
  /** Embedded sessions only: opens this session in the embedded form, expires with it. Never in a webhook. */
  client_secret?: string
  status: 'open' | 'complete' | 'expired'
  amount_cents: number
  currency: string
  description: string
  reference: string | null
  metadata: Metadata
  customer_email: string | null
  success_url: string | null
  cancel_url: string | null
  return_url: string | null
  pay_account_id: string
  payment_id: string | null
  payment_status: PayPaymentStatus | null
  livemode: boolean
  expires_at: string
  completed_at: string | null
  created_at: string
}

export type PayPaymentStatus = 'pending' | 'succeeded' | 'failed' | 'canceled' | 'refunded' | 'partially_refunded'

export interface PayPaymentListParams {
  status?: PayPaymentStatus
  reference?: string
  session_id?: string
  /** YYYY-MM-DD, included. */
  from?: string
  /** YYYY-MM-DD, included. */
  to?: string
  pay_account_id?: string
  page?: number
  /** 100 at most. */
  per_page?: number
}

export interface PayRefund {
  id: string
  object: 'pay.refund'
  payment_id: string
  amount_cents: number
  currency: string
  status: string
  reason: string | null
  created_at: string
  reference?: string | null
  session_id?: string | null
  payment?: Pick<PayPayment, 'id' | 'object' | 'status' | 'amount_cents' | 'refunded_cents'>
}

/**
 * A dispute: `open` until the buyer's bank decides, then `won`, `lost`, or
 * `closed` (a mere information request, nothing debited). The disputed amount
 * is debited from the Pay account when the dispute opens and credited back if
 * it is won. A disputed payment can no longer be refunded.
 */
export interface PayDispute {
  status: 'open' | 'won' | 'lost' | 'closed'
  amount_cents: number
  /** The deadline for your evidence. */
  evidence_due_at: string | null
  debited_cents: number
  recredited_cents: number
}

export interface PayPayment {
  id: string
  object: 'pay.payment'
  status: PayPaymentStatus
  amount_cents: number
  fee_cents: number
  refunded_cents: number
  net_cents: number
  currency: string
  reference: string | null
  metadata: Metadata
  session_id: string | null
  link_id: string | null
  pay_account_id: string
  customer_email: string | null
  customer_name: string | null
  payment_method: string | null
  disputed: boolean
  /** The buyer's dispute, null without one. */
  dispute: PayDispute | null
  failure_message: string | null
  livemode: boolean
  created_at: string
  paid_at: string | null
  /** Present when the payment is retrieved alone. */
  refunds?: PayRefund[]
}

export interface PayRefundCreateParams {
  /** Default: everything still refundable. */
  amount_cents?: number | null
  reason?: string | null
}

export type PayEventType =
  | 'payment.succeeded'
  | 'payment.failed'
  | 'refund.succeeded'
  | 'dispute.opened'
  | 'dispute.closed'
  | 'session.expired'

export interface WebhookEndpoint {
  id: string
  url: string
  description: string | null
  events: PayEventType[]
  enabled: boolean
  secret_hint: string
  secret_rotated_at: string | null
  created_at: string
  /** Only in the answer of create() and rotateSecret(): store it at once. */
  secret?: string
  deliveries?: WebhookDelivery[]
  [key: string]: unknown
}

export interface WebhookEndpointCreateParams {
  url: string
  events: PayEventType[]
  description?: string | null
  enabled?: boolean
}

export type WebhookEndpointUpdateParams = Partial<WebhookEndpointCreateParams>

export interface WebhookDelivery {
  id: string
  event_id: string
  event_type: PayEventType
  status: 'pending' | 'succeeded' | 'failed'
  attempts: number
  last_status_code: number | null
  last_duration_ms: number | null
  last_error: string | null
  next_attempt_at: string | null
  delivered_at: string | null
  created_at: string
  [key: string]: unknown
}

export interface WebhookDeliveryListParams {
  status?: 'pending' | 'succeeded' | 'failed'
  /** Add the attempts and the payload. */
  detail?: boolean
  page?: number
  per_page?: number
}

/** The event delivered to your webhook endpoint. */
export interface MyAdionEvent<T = Record<string, unknown>> {
  id: string
  object: 'event'
  type: PayEventType | (string & {})
  api_version: string
  created: string
  livemode: boolean
  pay_account_id: string
  data: { object: T }
}

export interface SmsSendParams {
  service_id: string
  /** One number, or up to 500. */
  to: string | string[]
  /** 1 600 characters at most. */
  message: string
  type: 'transactional' | 'commercial'
  sender?: string | null
  reference?: string | null
}

export interface SmsMessage {
  id: string
  service_id: string
  to: string
  type: 'transactional' | 'commercial'
  status: 'queued' | 'sent' | 'delivered' | 'failed'
  segments: number
  credits: number
  sender: string | null
  reference: string | null
  scheduled_for: string | null
  sent_at: string | null
  delivered_at: string | null
  failure: string | null
}

export interface SmsBatch {
  batch_id: string
  credits: number
  balance: number
  messages: SmsMessage[]
  rejected: { to: string; reason: string; reason_label: string }[]
}

/** The raw HTTP answer of the last call. */
export interface LastResponse {
  status: number
  headers: Record<string, string>
}
