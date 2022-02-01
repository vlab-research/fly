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

  next(form, qa, ref, field, fieldValue, required) {
    const isValid = v.validateFieldValue(field, fieldValue, required);
    if (isValid) {
      return {
        ref: f.getNextField(form, qa, ref, field).ref,
        action: "navigate",
      };
    } else {
      return {
        ref: f.getField(form, ref).ref,
        action: "error",
        error: v.validator(field)(fieldValue),
      };
    }
  }

  interpolate(field, qa) {
    const title = f.interpolateField(qa, field).title;
    return title;
  }
}

module.exports = { ResponseStore };
