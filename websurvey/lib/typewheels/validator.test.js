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

describe("validateFieldValue", () => {
  it("evaluates to true if the user correctly submits a short text answer", () => {
    const field = {
      type: "short_text",
      title: "foo",
      ref: "foo",
    };
    const fieldValue = "baz";

    let res = v.validateFieldValue(field, fieldValue);
    res.should.equal(true);
  });

  it("evaluates to false if the user incorrectly submits a short text answer", () => {
    const field = {
      type: "short_text",
      title: "foo",
      ref: "foo",
    };
    const fieldValue = 10;

    let res = v.validateFieldValue(field, fieldValue);
    res.should.equal(false);
  });

  it("evaluates to true if the user correctly submits an email", () => {
    const field = {
      title: "What's your email address?",
      ref: "email",
      type: "email",
    };
    const fieldValue = "baz@gmail.com";

    let res = v.validateFieldValue(field, fieldValue);
    res.should.equal(true);
  });

  it("evaluates to false if the user incorrectly submits an email", () => {
    const field = {
      title: "What's your email address?",
      ref: "email",
      type: "email",
    };
    const fieldValue = "@gmail.com";

    let res = v.validateFieldValue(field, fieldValue);
    res.should.equal(false);
  });

  it("evaluates to false if the user incorrectly submits a quick reply", () => {
    const field = {
      title:
        "Welcome! 😀\nWe are a team of researchers conducting a study about life and opinions of young people in India. In the coming weeks, we will share with you some nice and short videoclips that you can watch for free. We will also ask you some questions about them. If you agree to take part to this study and you answer our questions, then you will have the chance of winning up to *10 Samsung Galaxy s8!*\n\nYour answers will always remain confidential.\n\nBy clicking the Accept botton, you confirm you have read and accept the _General Terms and Conditions_ contained in the Consent Form available at the link below.\n",
      ref: "4cc5c31b-6d23-4d50-8536-7abf1cdf0782",
      properties: {
        choices: [
          {
            id: "Hq797lCsF9jY",
            ref: "Accept",
            label: "I accept",
          },
          {
            id: "dJnYKKeMQl6r",
            ref: "I do accept",
            label: "I do not accept",
          },
        ],
      },
      type: "multiple_choice",
    };

    const fieldValue = "foo";

    let res = v.validateFieldValue(field, fieldValue);
    res.should.equal(false);
  });
});
