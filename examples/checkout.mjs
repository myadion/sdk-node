// Create an Adion Pay session and print the payment page address.
//   MYADION_CLIENT_ID=… MYADION_CLIENT_SECRET=… node examples/checkout.mjs
import { InvalidRequestError, MyAdion, MyAdionError } from '@myadion/sdk'

const myadion = new MyAdion({
  clientId: process.env.MYADION_CLIENT_ID,
  clientSecret: process.env.MYADION_CLIENT_SECRET,
})

try {
  const session = await myadion.pay.sessions.create(
    {
      amount_cents: 4990,
      description: 'Order 4521',
      reference: 'ORDER-4521',
      metadata: { order_id: '4521' },
      success_url: 'https://shop.example.com/orders/4521/thanks?session_id={SESSION_ID}',
      cancel_url: 'https://shop.example.com/cart',
    },
    { idempotencyKey: 'order-4521' },
  )
  console.log(`Send the buyer to: ${session.url}`)
  console.log(`Test mode: ${session.livemode ? 'no' : 'yes'}`)
} catch (error) {
  if (error instanceof InvalidRequestError) {
    console.error(error.message, error.errors)
  } else if (error instanceof MyAdionError) {
    console.error(`${error.name}: ${error.message}`)
  } else {
    throw error
  }
  process.exitCode = 1
}
