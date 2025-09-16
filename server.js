import express from 'express'
import helmet from 'helmet'
import morgan from 'morgan'
import { request as undiciRequest } from 'undici'

const PORT = process.env.PORT || 3000
const globalConcurrency = parseInt(process.env.GLOBAL_CONCURRENCY || '6', 10)
const forwardTimeoutMs = parseInt(process.env.FORWARD_TIMEOUT_MS || '8000', 10)

const tokens = {} // load from .env or config as before

// Example hardcoded for clarity (replace with env parsing like before)
tokens["supersecrettoken"] = {
  allowedWebhooks: ["https://discord.com/api/webhooks/\\d+/[A-Za-z0-9_-]+"],
  rateLimit: 10,
  rateWindowSeconds: 60
}

const app = express()
app.use(helmet())
app.use(express.json({ limit: '128kb' }))
app.use(morgan('combined'))

const tokenBuckets = new Map()
function getBucket(token) {
  const now = Math.floor(Date.now() / 1000)
  if (!tokenBuckets.has(token)) tokenBuckets.set(token, { lastWindow: now, count: 0 })
  return tokenBuckets.get(token)
}

const semaphore = { active: 0 }
async function withConcurrency(fn) {
  while (semaphore.active >= globalConcurrency) await new Promise(r => setTimeout(r, 10))
  semaphore.active++
  try { return await fn() } finally { semaphore.active-- }
}

function isAllowedWebhook(tokenCfg, url) {
  if (!tokenCfg.allowedWebhooks || tokenCfg.allowedWebhooks.length === 0) return false
  return tokenCfg.allowedWebhooks.some(pattern => new RegExp(pattern).test(url))
}

app.post('/api/webhooks/:id/:token/:authToken', async (req, res) => {
  const { id, token, authToken } = req.params
  const userTokenCfg = tokens[authToken]
  if (!userTokenCfg) return res.status(401).json({ ok: false, error: 'invalid auth token' })

  const webhook = `https://discord.com/api/webhooks/${id}/${token}`

  if (!isAllowedWebhook(userTokenCfg, webhook)) return res.status(403).json({ ok: false, error: 'webhook not allowed' })

  const now = Math.floor(Date.now() / 1000)
  const bucket = getBucket(authToken)
  if (now - bucket.lastWindow >= userTokenCfg.rateWindowSeconds) { bucket.lastWindow = now; bucket.count = 0 }
  if (bucket.count >= userTokenCfg.rateLimit) return res.status(429).json({ ok: false, error: 'rate limit exceeded' })
  bucket.count++

  try {
    const result = await withConcurrency(async () => {
      const r = await undiciRequest(webhook, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': 'roblox-discord-proxy/1' },
        body: JSON.stringify(req.body),
        bodyTimeout: forwardTimeoutMs,
        headersTimeout: forwardTimeoutMs
      })
      const text = await r.body.text().catch(() => '')
      return { statusCode: r.statusCode, body: text }
    })
    return res.status(200).json({ ok: true, proxied: true, status: result.statusCode, remoteBody: result.body })
  } catch (err) {
    return res.status(502).json({ ok: false, error: 'forward_failed', details: String(err) })
  }
})
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), timestamp: Date.now() })
})

app.listen(PORT, () => console.log(`proxy listening on ${PORT}`))
