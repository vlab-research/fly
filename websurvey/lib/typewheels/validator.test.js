const mocha = require("mocha");
const chai = require("chai");
const should = chai.should();
const v = require("./validator");
const f = require("./form");
const fs = require("fs");
const sample = JSON.parse(fs.readFileSync("mocks/sample.json"));
const form = f.translateForm(sample);

describe("validator", () => {
  it("should validate numbers", () => {
    const field = {
      type: "number",
      title: "foo",
      ref: "foo",
      validations: { required: false },
    };

    let res = v.validator(field)("918888000000");

    res.valid.should.equal(true);
    res = v.validator(field)(8888000000);
    res.valid.should.equal(true);
    res = v.validator(field)("8,888,000");
    res.valid.should.equal(true);
    res = v.validator(field)("8.888.000");
    res.valid.should.equal(true);
    res = v.validator(field)("88.000");
    res.valid.should.equal(true);
    res = v.validator(field)("1,000");
    res.valid.should.equal(true);
    res = v.validator(field)("1.0");
    res.valid.should.equal(true);
    res = v.validator(field)("-1.0");
    res.valid.should.equal(true);
    res = v.validator(field)("-0.04");
    res.valid.should.equal(true);
    res = v.validator(field)("8888 mil");
    res.valid.should.equal(false);
    res = v.validator(field)("five thousand");
    res.valid.should.equal(false);
  });

  it("should validate field value as type string", () => {
    const field = {
      type: "short_text",
      title: "foo",
      ref: "foo",
      validations: { required: false },
    };
    const res = v.validator(field)("baz");
    typeof res.valid.should.equal(true);
  });
});

describe("isNumber", () => {
  it("should return a boolean based on whether field value is a number", () => {
    const qa = [["whats_your_age", 10]];
    const qa2 = [["whats_your_age", "foo"]];
    const ref = "whats_your_age";

    const yes = f.getFieldValue(qa, ref);
    let res = v.isNumber(yes);
    res.should.equal(true);

    const no = f.getFieldValue(qa2, ref);
    res = v.isNumber(no);
    res.should.equal(false);
  });
});

describe("isString", () => {
  it("should return a boolean based on whether a field value is a string", () => {
    const qa = [["whats_your_name", "baz"]];
    const qa2 = [["whats_your_name", "10"]];
    const ref = "whats_your_name";

    const yes = f.getFieldValue(qa, ref);
    let res = v.isString(yes);
    res.should.equal(true);

    const no = f.getFieldValue(qa2, ref);
    res = v.isString(no);
    res.should.equal(false);
  });
});

describe("validateFieldValue", () => {
  it("evaluates to true if the user correctly submits an answer", () => {
    const field = {
      type: "short_text",
      title: "foo",
      ref: "foo",
    };
    const fieldValue = "baz";

    let res = v.validateFieldValue(field, fieldValue);
    res.should.equal(true);
  });

  it("evaluates to false if the user incorrectly submits an answer", () => {
    const field = {
      type: "short_text",
      title: "foo",
      ref: "foo",
    };
    const fieldValue = 10;

    let res = v.validateFieldValue(field, fieldValue);
    res.should.equal(false);
  });
});
