require('dotenv').config()

const r2 = require('r2')
const fs = require('fs')
const args = process.argv.slice(2)


async function foo() {
  for (const FORM of args) {

    const fi = fs.readFileSync(`../facebot/testrunner/forms/${FORM}.json`);
    const json = JSON.parse(fi);

    console.log(json)

    const headers = { Authorization: `Bearer ${process.env.TYPEFORM_KEY}` }
    const res = await r2.put(`https://api.typeform.com/forms/${FORM}`, { headers, json }).response
    const f = await res.json()
    if (f.code) {
      throw new Error(JSON.stringify(f))
    }
  }
}

foo()
