require('dotenv').config()

const fs = require('fs')
const args = process.argv.slice(2)


async function foo() {
  for (const FORM of args) {

    const fi = fs.readFileSync(`../facebot/testrunner/forms/${FORM}.json`);
    const json = JSON.parse(fi);

    console.log(json)

    const headers = { Authorization: `Bearer ${process.env.TYPEFORM_KEY}`, 'Content-Type': 'application/json' }
    const res = await fetch(`https://api.typeform.com/forms/${FORM}`, { method: 'PUT', headers, body: JSON.stringify(json) })
    const f = await res.json()
    if (f.code) {
      throw new Error(JSON.stringify(f))
    }
  }
}

foo()
