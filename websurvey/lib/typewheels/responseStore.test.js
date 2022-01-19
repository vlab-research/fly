const mocha = require("mocha");
const chai = require("chai");
const should = chai.should();
const r = require("./responseStore");
const fs = require("fs");
const form = JSON.parse(fs.readFileSync("mocks/sample.json"));

describe("Unit Tests For Response Store", () => {
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

  it("returns an error if an empty answer is submitted to a required question", () => {
    const responseStore = new r.ResponseStore();

    const field = {
      type: "short_text",
      title: "whats_your_name",
      ref: "whats_your_name",
    };

    let fieldValue = " ";

    let qa = [["whats_your_name", " "]];

    const ref = "whats_your_name";

    let required = true;

    const value = responseStore.nextAction(
      form,
      field,
      fieldValue,
      qa,
      ref,
      required
    );

    value.action.should.equal("error");
  });

  it("instructs the form to throw an error if an answer evaluates to invalid", () => {
    const responseStore = new r.ResponseStore();

    const field = {
      type: "short_text",
      title: "whats_your_name",
      ref: "whats_your_name",
    };

    const fieldValue = " ";

    const qa = [["whats_your_name", " "]];

    const ref = "whats_your_name";

    const required = true;

    const value = responseStore.nextAction(
      form,
      field,
      fieldValue,
      qa,
      ref,
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
    };

    const fieldValue = "foo";

    const qa = [["whats_your_name", "foo"]];

    const ref = "whats_your_name";

    let required = true;

    const value = responseStore.nextAction(
      form,
      field,
      fieldValue,
      qa,
      ref,
      required
    );

    value.action.should.equal("navigate");

    required = false;

    responseStore.nextAction(form, field, fieldValue, qa, ref, required);

    value.action.should.equal("navigate");
  });
});
