require('dotenv').config()
const r2 = require('r2')
// const { getForm } = require('./lib/typewheels/typeform')
const fs = require('fs')

const args = process.argv.slice(2)


async function getForm(form) {
  if (!form) {
    throw new TypeError(`Trying to get a form without a value!`)
  }
  const headers = { Authorization: `Bearer ${process.env.TYPEFORM_KEY}` }
  const res = await r2(`https://api.typeform.com/forms/${form}`, { headers }).response
  const f = await res.json()
  if (f.code) {
    throw new Error(JSON.stringify(f))
  }

  return [f]

}

async function foo() {
  for (let FORM of args) {
    const forms = await getForm(FORM)
    const form = forms[0]
    fs.writeFileSync(`../facebot/testrunner/forms/${FORM}.json`, JSON.stringify(form, null, 2))
  }
}

foo()
