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
      type: "number",
      title: "Welcome!\nHow old are you?",
      ref: "378caa71-fc4f-4041-8315-02b6f33616b9",
    };

    const fieldValue = "baz";
    const qa = [["378caa71-fc4f-4041-8315-02b6f33616b9", "baz"]];
    const ref = "378caa71-fc4f-4041-8315-02b6f33616b9";
    const value = responseStore.next(form, qa, ref, field, fieldValue);

    value.action.should.equal("error");
  });

  it("instructs the form to go to the next field if an answer evaluates to valid", () => {
    const responseStore = new r.ResponseStore();

    const field = {
      type: "number",
      title: "Welcome!\nHow old are you?",
      ref: "378caa71-fc4f-4041-8315-02b6f33616b9",
    };

    const fieldValue = 10;
    const qa = [["378caa71-fc4f-4041-8315-02b6f33616b9", 20]];
    const ref = field.ref;
    const res = responseStore.next(form, qa, ref, field, fieldValue);

    res.action.should.equal("navigate");
  });

  it("instructs the form to go to the next field if an answer evaluates to valid", () => {
    const responseStore = new r.ResponseStore();

    const field = {
      type: "legal",
      title:
        "Welcome! 😀\nWe are a team of researchers conducting a study about life and opinions of young people in India. In the coming weeks, we will share with you some nice and short videoclips that you can watch for free. We will also ask you some questions about them. If you agree to take part to this study and you answer our questions, then you will have the chance of winning up to *10 Samsung Galaxy s8!*\n\nYour answers will always remain confidential.\n\nBy clicking the Accept botton, you confirm you have read and accept the _General Terms and Conditions_ contained in the Consent Form available at the link below.\n",
      ref: "4cc5c31b-6d23-4d50-8536-7abf1cdf0782",
    };
    const fieldValue = "4cc5c31b-6d23-4d50-8536-7abf1cdf0782";
    const qa = [
      [
        "4cc5c31b-6d23-4d50-8536-7abf1cdf0782",
        "4cc5c31b-6d23-4d50-8536-7abf1cdf0782",
      ],
    ];
    const ref = field.ref;
    const res = responseStore.next(form, qa, ref, field, fieldValue);

    res.action.should.equal("navigate");
  });
});
