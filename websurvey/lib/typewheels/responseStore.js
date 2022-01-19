const v = require("./validator");
const f = require("./form");
const form = require("./form");

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

  nextAction(form, field, fieldValue, qa, ref, required) {
    const isValid = v.validateFieldValue(field, fieldValue, required);
    if (form.fields.indexOf(field) < form.fields.length - 1) {
      if (isValid) {
        return {
          ref: f.getNextField(form, qa, ref).ref,
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
  }
}

module.exports = { ResponseStore };
