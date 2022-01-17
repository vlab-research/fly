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

    if (!res.valid || (isRequired && !fieldValue.replace(/\s/g, "").length)) {
      // alert(res.message); TODO put this biz logic into the validator and have it decide which message to show in an obj
      return false;
    }

    return true;
  }
}

module.exports = { ResponseStore };
