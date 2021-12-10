const mocha = require("mocha");
const chai = require("chai");
const should = chai.should();
const f = require("./form.js");
const fs = require("fs");
const form = JSON.parse(fs.readFileSync("mocks/sample.json"));

describe("getField", () => {
  it("gets a field", () => {
    const ctx = form;
    const value = f.getField(ctx, "whats_your_name");
    value.should.equal(form.fields[0]);
  });

  it("throws with a useful message when field not found in form", () => {
    const ctx = form;
    const fn = f.getField(ctx, "baz");
    fn.should.throw(/baz/); // field
    fn.should.throw(/DjlXLX2s/); // form
  });
});

describe("getThankyouScreen", () => {
  it("gets thankyou screen", () => {
    const ctx = form;
    const value = f.getThankyouScreen(ctx, "thankyou");
    value.should.equal(form.thankyou_screens[0]);
  });

  it("throws with a useful message when thankyou screen not found in form", () => {
    const ctx = form;
    const fn = f.getThankyouScreen(ctx, "baz");
    fn.should.throw(/baz/); // thankyou screen
    fn.should.throw(/DjlXLX2s/); // form
  });
});

describe("isLast", () => {
  it("checks if a field is last", () => {
    const ctx = form;
    const value = f.isLast(ctx, "how_is_your_day");
    value.should.equal(true);
  });
});

describe("setFirstRef", () => {
  it("sets the first field ref", () => {
    const ctx = form;
    const value = f.setFirstRef(ctx, 0);
    value.should.equal("whats_your_name");
  });
});

describe("getNext", () => {
  it("gets the next field object in the form", () => {
    const ctx = form;
    const value = f.getNext(ctx, "whats_your_name");
    value.should.equal(form.fields[1]);
  });
});
