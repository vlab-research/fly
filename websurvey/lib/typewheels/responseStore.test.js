const mocha = require("mocha");
const chai = require("chai");
const should = chai.should();
const r = require("./responseStore");

describe("Test Fly Survey Integration Testing", () => {
  it("returns a snapshot of the current field and field value", () => {
    const responseStore = new r.ResponseStore();
    const ref = "what's_your_name";
    const fieldValue = "foo";

    const snapshot = responseStore.snapshot(ref, fieldValue);
    snapshot.should.eql([ref, fieldValue]);
  });

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

  it("evaluates to true if the user correctly submits an answer", () => {
    const responseStore = new r.ResponseStore();

    let field = {
      type: "short_text",
      title: "foo",
      ref: "foo",
    };
    let fieldValue = "baz";
    const isRequired = false;

    let res = responseStore.validateFieldValue(field, fieldValue, isRequired);
    res.should.equal(true);

    field = {
      type: "number",
      title: "foo",
      ref: "foo",
    };

    fieldValue = 10;

    res = responseStore.validateFieldValue(field, fieldValue, isRequired);
    res.should.equal(true);
  });

  it("evaluates to false if the user submits an empty answer to a required question", () => {
    const responseStore = new r.ResponseStore();

    let field = {
      type: "short_text",
      title: "foo",
      ref: "foo",
    };
    let fieldValue = " ";
    const isRequired = true;

    let res = responseStore.validateFieldValue(field, fieldValue, isRequired);
    res.should.equal(false);
  });
});
