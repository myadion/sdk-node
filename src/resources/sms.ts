import type { MyAdion } from '../client.js'
import type { RequestOptions, SmsBatch, SmsMessage, SmsSendParams } from '../types.js'
import { path } from './path.js'

/** Adion SMS. */
export class SmsResource {
  constructor(private readonly client: MyAdion) {}

  /**
   * Send one text message, or the same one to up to 500 numbers (scope
   * `sms.message.send`). Sending is not idempotent: the library retries it
   * only after a 429 (refused before sending).
   */
  send(params: SmsSendParams, options?: RequestOptions): Promise<SmsBatch> {
    return this.client.request('POST', '/v1/sms', { ...params }, options)
  }

  /** One message and its status: queued, sent, delivered or failed (scope `sms.service.read`). */
  retrieve(id: string, options?: RequestOptions): Promise<SmsMessage> {
    return this.client.request('GET', path`/v1/sms/${id}`, {}, options)
  }
}
