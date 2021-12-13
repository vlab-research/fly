const r2 = require('r2')

async function getSurveyMetadata(surveyId) {

  const url = `${process.env.FORMCENTRAL_URL}/metadata?surveyid=${surveyId}`
  const res = await r2(url).response

  if (res.status === 404) return
  return await res.json()
}

module.exports = { getSurveyMetadata }
