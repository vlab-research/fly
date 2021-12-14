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

describe("getFieldValue", () => {
  it("gets the value of a text field", () => {
    const qa = [["foo", "foo"]];
    const value = f.getFieldValue(qa, "foo");
    value.should.equal("foo");
  });

  // TODO: should this throw?
  it("returns null if the field doesnt exist", () => {
    const qa = [];
    const value = f.getFieldValue(qa, "foo");
    should.not.exist(value);
  });
});

describe("getChoiceValue", () => {
  it("gets the value of the selected multiple choice field", () => {
    const ctx = form;
    const value = f.getChoiceValue(
      ctx,
      "how_is_your_day",
      ctx.fields[2].properties.choices[0]
    );
    value.should.equal("Not so well...");
  });
});

describe("getVar", () => {
  it("gets the value depending on the var type", () => {
    const ctx = form;
    const qa = [["baz", "10"]];
    const ref = "whats_your_name";
    const vars = ctx.logic[0].actions[0].condition.vars;
    const v = vars[1];

    const value = f.getVar(ctx, qa, ref, vars, v);
    value.should.equal("");
  });
});

// TODO integrate logic
// describe("getNextField", () => {
//   it("gets the next field in the form including any logic", () => {
//     const ctx = form;
//     const value = f.getNextField(ctx, "whats_your_name");
//     value.should.equal("hows_your_day");
//   });
// });

// describe("jump", () => {
//   it("makes jump when required and makes no jump when not", () => {
//     const logic = form.logic[0];
//     const qaGood = [["378caa71-fc4f-4041-8315-02b6f33616b9", "18"]];
//     const qaBad = [["378caa71-fc4f-4041-8315-02b6f33616b9", "10"]];

//     const yes = f.jump({ form }, qaGood, logic);
//     yes.should.equal("0ebfe765-0275-48b2-ad2d-3aacb5bc6755");

//     const no = f.jump({ form }, qaBad, logic);
//     no.should.equal("3edb7fcc-748c-461c-bacd-593c043c5518");
//   });
// });
