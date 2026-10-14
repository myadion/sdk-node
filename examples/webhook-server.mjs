// Receive Adion Pay webhooks with node:http, no framework.
//   MYADION_WEBHOOK_SECRET=whsec_… node examples/webhook-server.mjs
import { createServer } from 'node:http'
import { MyAdion } from '@myadion/sdk'

createServer(async (req, res) => {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const body = Buffer.concat(chunks) // the raw body, never re-encoded

  let event
  try {
    event = MyAdion.webhooks.constructEvent(body, req.headers['adion-signature'], process.env.MYADION_WEBHOOK_SECRET)
  } catch {
    res.writeHead(400).end()
    return
  }

  // The same event may arrive twice: remember event.id and skip what you already handled.
  if (event.type === 'payment.succeeded') {
    console.log('paid:', event.data.object.reference)
  }
  res.writeHead(204).end()
}).listen(8000)
