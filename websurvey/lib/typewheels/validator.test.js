const mocha = require("mocha");
const chai = require("chai");
const should = chai.should();
const v = require("./validator");
const f = require("./form");

describe("validator", () => {
  it("should validate field value as type string", () => {
    const field = {
      type: "string",
      title: "foo",
      ref: "foo",
    };
    console.log(v.validator(field)("bar"));
    const res = v.validator(field("bar"));
    console.log(res);
    typeof res.valid.should.equal("string");
  });

  it("should validate numbers", () => {
    const field = {
      type: "number",
      title: "foo",
      ref: "foo",
    };

    let res = v.validator(field)("918888000000");
    console.log(res);

    res.valid.should.equal(true);
    console.log(res.valid);

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

  it("should return a boolean based on whether field value is a number", () => {
    const qa = [["whats_your_age", 10]];
    const qa2 = [["whats_your_age", "foo"]];
    const ref = "whats_your_age";
    const yes = f.getFieldValue(qa, ref);
    let res = v.isNumber(yes);
    console.log("yes:" + res);
    const no = f.getFieldValue(qa2, ref);
    res = v.isNumber(no);
    console.log("no:" + res);
    res.should.equal(false);
  });
});
