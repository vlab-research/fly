const Koa = require('koa')
const bodyParser = require('koa-bodyparser')
const cors = require('@koa/cors')
const http = require('http')
const Router = require('koa-router')

const { producer, producerReady } = require('./producer')
const { handleMessengerEvents, handleSyntheticEvents, verifyToken } = require('./handlers')

const EVENT_TOPIC = process.env.BOTSERVER_EVENT_TOPIC

const router = new Router()
router.get('/webhooks', verifyToken)
router.post('/webhooks', (ctx) => handleMessengerEvents(ctx, producer, producerReady, EVENT_TOPIC))
router.post('/synthetic', (ctx) => handleSyntheticEvents(ctx, producer, producerReady, EVENT_TOPIC))
router.get('/health', async ctx => {
  await producerReady
  ctx.status = 200
})

const app = new Koa()
app
  .use(bodyParser())
  .use(cors())
  .use(router.routes())
  .use(router.allowedMethods())

http.createServer(app.callback()).listen(process.env.PORT || 8080)
