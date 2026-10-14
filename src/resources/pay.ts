import type { MyAdion } from '../client.js'
import type { PagePromise } from '../pagination.js'
import type {
  PayPayment,
  PayPaymentListParams,
  PayRefund,
  PayRefundCreateParams,
  PaySession,
  PaySessionCreateParams,
  RequestOptions,
  WebhookDelivery,
  WebhookDeliveryListParams,
  WebhookEndpoint,
  WebhookEndpointCreateParams,
  WebhookEndpointUpdateParams,
} from '../types.js'
import { path } from './path.js'

/** Payment sessions: the buyer pays on Adion's payment page, then comes back to `success_url`. */
export class SessionsResource {
  constructor(private readonly client: MyAdion) {}

  /**
   * Create a session (scope `pay.session.write`). Without `idempotencyKey`,
   * the library makes one up, so its own retries never create a second
   * session. Give your own (one per order) to make your retries safe too.
   */
  create(params: PaySessionCreateParams, options?: RequestOptions): Promise<PaySession> {
    return this.client.request('POST', '/v1/pay/sessions', { ...params }, options)
  }

  /** Read a session (scope `pay.payment.read`). */
  retrieve(id: string, options?: RequestOptions): Promise<PaySession> {
    return this.client.request('GET', path`/v1/pay/sessions/${id}`, {}, options)
  }
}

/** Payments, most recent first (scope `pay.payment.read`). */
export class PaymentsResource {
  constructor(private readonly client: MyAdion) {}

  /** Await it for one page, or `for await` it for every payment. */
  list(params: PayPaymentListParams = {}, options?: RequestOptions): PagePromise<PayPayment> {
    return this.client.requestCollection('GET', '/v1/pay/payments', { ...params }, options)
  }

  /** One payment, with its `refunds`. */
  retrieve(id: string, options?: RequestOptions): Promise<PayPayment> {
    return this.client.request('GET', path`/v1/pay/payments/${id}`, {}, options)
  }
}

/** Refunds (scope `pay.refund.write`). */
export class RefundsResource {
  constructor(private readonly client: MyAdion) {}

  /**
   * Refund all or part of a payment. A refund moves money: the library does
   * not retry it after a server error or a lost connection.
   */
  create(paymentId: string, params: PayRefundCreateParams = {}, options?: RequestOptions): Promise<PayRefund> {
    return this.client.request('POST', path`/v1/pay/payments/${paymentId}/refunds`, { ...params }, options)
  }
}

/**
 * The webhook endpoints of a Pay account (scope `pay.webhook.manage`). The
 * signing secret comes back once, from `create()` and `rotateSecret()`.
 */
export class WebhookEndpointsResource {
  constructor(private readonly client: MyAdion) {}

  /** The endpoints of the account; `page.raw.event_types` lists the events. */
  list(payAccountId: string, options?: RequestOptions): PagePromise<WebhookEndpoint> {
    return this.client.requestCollection('GET', path`/account/pay/${payAccountId}/webhook`, {}, options)
  }

  create(payAccountId: string, params: WebhookEndpointCreateParams, options?: RequestOptions): Promise<WebhookEndpoint> {
    return this.client.request('POST', path`/account/pay/${payAccountId}/webhook`, { ...params }, options)
  }

  /** An endpoint, with its latest deliveries. */
  retrieve(payAccountId: string, id: string, options?: RequestOptions): Promise<WebhookEndpoint> {
    return this.client.request('GET', path`/account/pay/${payAccountId}/webhook/${id}`, {}, options)
  }

  update(payAccountId: string, id: string, params: WebhookEndpointUpdateParams, options?: RequestOptions): Promise<WebhookEndpoint> {
    return this.client.request('PUT', path`/account/pay/${payAccountId}/webhook/${id}`, { ...params }, options)
  }

  delete(payAccountId: string, id: string, options?: RequestOptions): Promise<{ deleted: boolean }> {
    return this.client.request('DELETE', path`/account/pay/${payAccountId}/webhook/${id}`, {}, options)
  }

  /** A new signing secret, effective at once (the old one stops working). */
  rotateSecret(payAccountId: string, id: string, options?: RequestOptions): Promise<WebhookEndpoint> {
    return this.client.request('POST', path`/account/pay/${payAccountId}/webhook/${id}/secret`, {}, options)
  }

  /** The delivery log; `detail: true` adds the attempts and the payload. */
  deliveries(payAccountId: string, id: string, params: WebhookDeliveryListParams = {}, options?: RequestOptions): PagePromise<WebhookDelivery> {
    return this.client.requestCollection('GET', path`/account/pay/${payAccountId}/webhook/${id}/delivery`, { ...params }, options)
  }

  /** Send a delivery again, now. */
  resendDelivery(payAccountId: string, id: string, deliveryId: string, options?: RequestOptions): Promise<WebhookDelivery> {
    return this.client.request('POST', path`/account/pay/${payAccountId}/webhook/${id}/delivery/${deliveryId}/resend`, {}, options)
  }
}

/** Adion Pay. */
export class PayResource {
  readonly sessions: SessionsResource
  readonly payments: PaymentsResource
  readonly refunds: RefundsResource
  readonly webhookEndpoints: WebhookEndpointsResource

  constructor(client: MyAdion) {
    this.sessions = new SessionsResource(client)
    this.payments = new PaymentsResource(client)
    this.refunds = new RefundsResource(client)
    this.webhookEndpoints = new WebhookEndpointsResource(client)
  }
}
