// The built ES module loads and exposes the client (run after `npm run build`).
import assert from 'node:assert'
import MyAdion, { MyAdion as Named, SignatureVerificationError } from '../dist/index.js'

assert.strictEqual(MyAdion, Named)
const header = MyAdion.webhooks.generateTestHeaderString({ payload: '{}', secret: 'whsec_x' })
assert.deepStrictEqual(MyAdion.webhooks.constructEvent('{}', header, 'whsec_x'), {})
assert.throws(() => MyAdion.webhooks.constructEvent('{}', header, 'whsec_y'), SignatureVerificationError)
console.log('esm ok')
