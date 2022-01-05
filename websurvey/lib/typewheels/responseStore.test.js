const mocha = require("mocha");
const chai = require("chai");
const should = chai.should();
const r = require("./responseStore");

///////////////////////////////////////////////
// TESTS -----------------------------------
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
});
