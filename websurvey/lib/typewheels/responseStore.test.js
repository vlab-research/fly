const mocha = require("mocha");
const chai = require("chai");
const should = chai.should();
const r = require("./responseStore");
const f = require("./form");
const fs = require("fs");
const sample = JSON.parse(fs.readFileSync("mocks/sample.json"));
const form = f.translateForm(sample);

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

    ref = "how_is_your_day";
    fieldValue = "Terrific!";

    responseStore.snapshot(ref, fieldValue);

    const qa = responseStore.getQa();

    qa.should.eql([
      ["what's_your_name", "foo"],
      ["how_is_your_day", "Terrific!"],
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
    };

    const fieldValue = 10;
    const qa = [["whats_your_name", 10]];
    const ref = "whats_your_name";
    const value = responseStore.next(form, qa, ref, field, fieldValue);

    value.action.should.equal("error");
  });

  it("instructs the form to go to the next field if an answer evaluates to valid", () => {
    const responseStore = new r.ResponseStore();

    const field = {
      type: "short_text",
      title: "whats_your_name",
      ref: "whats_your_name",
    };

    const fieldValue = "foo";
    const qa = [["whats_your_name", "foo"]];
    const ref = field.ref;
    const res = responseStore.next(form, qa, ref, field, fieldValue);

    res.action.should.equal("navigate");
  });
});
