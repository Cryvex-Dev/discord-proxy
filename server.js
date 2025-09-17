import express from 'express'
import helmet from 'helmet'
import morgan from 'morgan'
import { request as undiciRequest } from 'undici'

const PORT = process.env.PORT || 3000
const globalConcurrency = parseInt(process.env.GLOBAL_CONCURRENCY || '6', 10)
const forwardTimeoutMs = parseInt(process.env.FORWARD_TIMEOUT_MS || '8000', 10)


const allowedWebhooks = (process.env.ALLOWED_WEBHOOKS || '')
  .split(';')
  .map(p => p.trim())
  .filter(Boolean)

const app = express()
app.use(helmet())
app.use(express.json({ limit: '128kb' }))
app.use(morgan('combined'))

const semaphore = { active: 0 }
async function withConcurrency(fn) {
  while (semaphore.active >= globalConcurrency) {
    await new Promise(r => setTimeout(r, 10))
  }
  semaphore.active++
  try { return await fn() } finally { semaphore.active-- }
}

function isAllowedWebhook(url) {
  if (allowedWebhooks.length === 0) return false
  return allowedWebhooks.some(pattern => new RegExp(pattern).test(url))
}

app.post('/api/webhooks/:id/:token', async (req, res) => {
  const { id, token } = req.params
  const webhook = `https://discord.com/api/webhooks/${id}/${token}`

  if (!isAllowedWebhook(webhook)) {
    return res.status(403).json({ ok: false, error: 'webhook not allowed' })
  }

  try {
    const result = await withConcurrency(async () => {
      const r = await undiciRequest(webhook, {
        method: 'POST',
        headers: { 
          'content-type': 'application/json',
          'user-agent': 'roblox-discord-proxy/1'
        },
        body: JSON.stringify(req.body),
        bodyTimeout: forwardTimeoutMs,
        headersTimeout: forwardTimeoutMs
      })
      const text = await r.body.text().catch(() => '')
      return { statusCode: r.statusCode, body: text }
    })
    return res.status(200).json({
      ok: true,
      proxied: true,
      status: result.statusCode,
      remoteBody: result.body
    })
  } catch (err) {
    return res.status(502).json({
      ok: false,
      error: 'forward_failed',
      details: String(err)
    })
  }
})

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: Date.now()
  })
})

app.listen(PORT, () => console.log(`proxy listening on ${PORT}`))
