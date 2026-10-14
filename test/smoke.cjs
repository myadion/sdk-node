// The built CommonJS bundle loads and exposes the client (run after `npm run build`).
const assert = require('node:assert')
const sdk = require('../dist/index.cjs')

assert.strictEqual(typeof sdk.MyAdion, 'function')
assert.strictEqual(sdk.default, sdk.MyAdion)
const client = new sdk.MyAdion({ clientId: 'a', clientSecret: 'b' })
assert.ok(client.pay.sessions && client.sms && client.webhooks)
assert.ok(new sdk.InvalidRequestError('x') instanceof sdk.MyAdionError)
console.log('cjs ok')
