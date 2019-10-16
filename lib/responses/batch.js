const {Responser} = require('./responser')
const Chatbase = require(process.env.CHATBASE_BACKEND)
const {PromiseStream} = require('@vlab-research/steez')
const QueryStream = require('pg-query-stream')
const {DBStream, messagesQuery} = require('./pgstream')

const chatbase = new Chatbase()
const emptyBase = { get: () => [], pool: chatbase.pool }
const responser = new Responser(emptyBase)
const fn = (lim) => messagesQuery(chatbase.pool, lim)


//. start from... 0?
const stream = new DBStream(fn, 0)

stream
  .pipe(new PromiseStream(({userid, content}) => responser.write({key:userid, value:content})))
  .on('error', (err) => {
    console.error(err)
  })
  .on('end', async () => {
    console.log('FINISHED WRITING')
    await chatbase.pool.end()
  })