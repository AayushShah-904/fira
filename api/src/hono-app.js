const { Hono } = require('hono')
const { cors } = require('hono/cors')

const app = new Hono()

// Enable CORS for all routes
app.use('*', cors())

// Health check endpoint
app.get('/health', (c) => c.json({ status: 'ok', runtime: 'Hono', timestamp: new Date().toISOString() }))

// General info
app.get('/api/v1', (c) => c.json({
  name: 'FIRA API',
  version: '1.0.0-hono',
  description: 'Fixed Income Rate Analytics API (Hono Serverless Engine)',
  endpoints: [
    '/api/v1/auth',
    '/api/v1/banks',
    '/api/v1/rates',
    '/api/v1/watchlists',
    '/api/v1/simulator',
    '/api/v1/feedback',
    '/api/v1/admin'
  ]
}))

// Error handler
app.onError((err, c) => {
  console.error('[Hono Error]', err)
  return c.json({ error: err.message || 'Internal Server Error' }, 500)
})

module.exports = app
