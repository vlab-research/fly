const mocha = require("mocha");
const chai = require("chai");
const should = chai.should();
const r = require("./responseStore");
const fs = require("fs");
const form = JSON.parse(fs.readFileSync("mocks/sample.json"));

describe("snapshot", () => {
  it("returns a snapshot of the current field and field value", () => {
    const responseStore = new r.ResponseStore();
    const ref = "what's_your_name";
    const fieldValue = "foo";

    const snapshot = responseStore.snapshot(ref, fieldValue);
    snapshot.should.eql([ref, fieldValue]);
  });
});

describe("getQa", () => {
  it("returns all snapshots", () => {
    const responseStore = new r.ResponseStore();

    let ref = "what's_your_name";
    let fieldValue = "foo";

    responseStore.snapshot(ref, fieldValue);

    ref = "what's_your_age";
    fieldValue = 10;

    responseStore.snapshot(ref, fieldValue);

    const qa = responseStore.getQa();
    qa.should.eql([
      ["what's_your_name", "foo"],
      ["what's_your_age", 10],
    ]);
  });
});

describe("next", () => {
  it("instructs the form to throw an error if an answer evaluates to invalid", () => {
    const responseStore = new r.ResponseStore();

    const field = {
      type: "short_text",
      title: "whats_your_name",
      ref: "whats_your_name",
      validations: {
        required: true,
      },
    };

    const fieldValue = " ";

    const qa = [["whats_your_name", " "]];

    const ref = "whats_your_name";

    const required = field.validations.required;

    const value = responseStore.next(
      form,
      qa,
      ref,
      field,
      fieldValue,
      required
    );

    value.action.should.equal("error");
  });

  it("instructs the form to go to the next field if an answer evaluates to valid", () => {
    const responseStore = new r.ResponseStore();

    const field = {
      type: "short_text",
      title: "whats_your_name",
      ref: "whats_your_name",
      validations: {
        required: true,
      },
    };

    const fieldValue = "foo";

    const qa = [["whats_your_name", "foo"]];

    const ref = field.ref;

    const required = field.validations.required;

    const res = responseStore.next(form, qa, ref, field, fieldValue, required);

    res.action.should.equal("navigate");
  });

  it("instructs the form to go to the next field if an answer evaluates to invalid but is not required", () => {
    const responseStore = new r.ResponseStore();

    const field = {
      type: "short_text",
      title: "whats_your_name",
      ref: "whats_your_name",
      validations: {
        required: false,
      },
    };

    const fieldValue = "foo";

    const qa = [["whats_your_name", " "]];

    const ref = field.ref;

    const required = field.validations.required;

    const res = responseStore.next(form, qa, ref, field, fieldValue, required);

    res.action.should.equal("navigate");
  });
});
