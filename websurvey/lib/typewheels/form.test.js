const mocha = require("mocha");
const chai = require("chai");
const should = chai.should();
const f = require("./form");
const form = require("../../mocks/typeformData.json");

describe("getField", () => {
  it("gets a field", () => {
    const ctx = { form };
    const value = f.getField(ctx, "whats_your_name");
    value.should.equal(form.fields[0]);
  });

  it("throws with a useful message when field not found in form", () => {
    const ctx = { form };
    const fn = f.getField(ctx, "baz");
    fn.should.throw(/baz/); // field
    fn.should.throw(/DjlXLX2s/); // form
  });
});

describe("getFieldResponse", () => {
  it("gets the response of a text field", () => {
    const qa = [["foo", "foo"]];
    const value = f.getFieldResponse(qa, "foo");
    value.should.equal("foo");
  });

  // TODO: should this throw?
  it("returns null if the field doesnt exist", () => {
    const qa = [];
    const value = f.getFieldResponse(qa, "foo");
    should.not.exist(value);
  });
});
