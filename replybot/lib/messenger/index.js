const BASE_URL = process.env.FACEBOOK_GRAPH_URL || "https://graph.facebook.com/v8.0"
const RETRIES = process.env.FACEBOOK_RETRIES || 5
const BASE_RETRY_TIME = process.env.FACEBOOK_BASE_RETRY_TIME || 400

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

async function facebookRequest(reqFn, retries = 0) {

  let res;

  try {
    res = await reqFn()

  } catch (e) {
    if (e.code === 'ETIMEDOUT' && retries < RETRIES) {
      await delay(Math.pow(2, retries) * BASE_RETRY_TIME)
      res = await facebookRequest(reqFn, retries + 1)
    }
    else {
      throw e
    }
  }

  if (res && res.error) {
    const retryCodes = [1200, 551]
    if (retryCodes.includes(res.error.code) && retries < RETRIES) {
      await delay(Math.pow(2, retries) * BASE_RETRY_TIME)
      return await facebookRequest(reqFn, retries + 1)
    }

    throw res.error
  }

  return res
}


async function getUserInfo(id, pageToken) {
  const url = `${BASE_URL}/${id}?fields=id,name,first_name,last_name`
  const headers = { Authorization: `Bearer ${pageToken}` }

  try {
    const user = await facebookRequest(() => fetch(url, { headers }).then(r => r.json()))
    return user;

  } catch (e) {
    console.error(e);
    return { id, name: '_', first_name: '_', last_name: '_' }
  }
}

module.exports = { getUserInfo }
