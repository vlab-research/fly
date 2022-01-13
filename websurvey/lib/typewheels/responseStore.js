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

  validateFieldValue(field, fieldValue, isRequired) {
    const res = v.validator(field)(fieldValue);
    if (!res.valid || (isRequired && fieldValue === " ")) {
      alert(res.message);
    }
    return res.valid;
  }
}

module.exports = { ResponseStore };
