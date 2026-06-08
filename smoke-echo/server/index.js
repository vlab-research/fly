const Koa = require('koa')
const bodyParser = require('koa-bodyparser')
const Router = require('koa-router')
const http = require('http')

const { verifyToken, handleWebhook, passback } = require('./handlers')

const router = new Router()
router.get('/webhook', verifyToken)
router.post('/webhook', handleWebhook)
router.get('/health', async ctx => { ctx.status = 200 })
// Manual thread-control recovery (POST with JSON body, or GET with ?userId=).
router.post('/admin/passback', passback)
router.get('/admin/passback', passback)

const app = new Koa()

// Log every inbound request (method, path, and how long it took). Health checks
// are noisy, so they're logged at a quieter level via the path itself.
app.use(async (ctx, next) => {
  const start = Date.now()
  await next()
  console.log(`[smoke-echo][http] ${ctx.method} ${ctx.path} -> ${ctx.status} (${Date.now() - start}ms)`)
})

app
  .use(bodyParser())
  .use(router.routes())
  .use(router.allowedMethods())

const port = process.env.PORT || 8080
http.createServer(app.callback()).listen(port, () => {
  console.log(`[smoke-echo] listening on port ${port}`)
})
