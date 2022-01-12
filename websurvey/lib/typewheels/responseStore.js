const v = require("./validator");
const f = require("./form");

class ResponseStore {
  constructor(qa = []) {
    this.qa = qa;
  }

  snapshot(ref, fieldValue) {
    const snapshot = [ref, fieldValue];
    this.qa.push(snapshot);
    return snapshot;
  }

  getQa() {
    return this.qa;
  }

  validateFieldValue(field, fieldValue) {
    const res = v.validator(field, fieldValue);
    console.log(res.valid);
    return res.valid;
  }
}

module.exports = { ResponseStore };
