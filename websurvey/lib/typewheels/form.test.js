const mocha = require("mocha");
const chai = require("chai");
const should = chai.should();
const f = require("./form.js");
const fs = require("fs");
const sample = JSON.parse(fs.readFileSync("mocks/sample.json"));
const form = f.translateForm(sample);

describe("getField", () => {
  it("gets a field", () => {
    const ctx = form;
    const value = f.getField(ctx, "whats_your_name");
    value.should.equal(form.fields[0]);
  });

  it("throws with a useful message when field not found in form", () => {
    const ctx = form;
    const fn = () => f.getField(ctx, "baz");
    fn.should.throw(/baz/); // field
    fn.should.throw(/DjlXLX2s/); // form
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
    const value = f.getNext(form, "whats_your_name");
    value.should.equal(form.fields[1]);
  });

  it("gets the first thankyou screen after the last question", () => {
    const value = f.getNext(form, "how_is_your_day");
    value.should.equal(form.fields[3]);
  });
});

describe("getFieldValue", () => {
  it("gets the value of a text field", () => {
    const qa = [["foo", "baz"]];
    const value = f.getFieldValue(qa, "foo");
    value.should.equal("baz");
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
    const qa = [["whats_your_name", "baz"]];
    const ref = "whats_your_name";
    const vars = ctx.logic[0].actions[0].condition.vars;
    const v = vars[0];
    const v2 = vars[1];
    const value = f.getVar(ctx, qa, ref, vars, v);
    const value2 = f.getVar(ctx, qa, ref, vars, v2);
    value.should.equal("baz");
    value2.should.equal(" ");
  });
});

describe("getCondition", () => {
  const cond = {
    op: "always",
    vars: [
      { type: "field", value: "baz" },
      { type: "constant", value: 10 },
    ],
  };

  it("works with always true", () => {
    f.getCondition({ form }, [], "", cond).should.be.true;
  });

  it("works with string equals and not equals, is and is not", () => {
    const cond = {
      op: "not_equal",
      vars: [
        { type: "field", value: "whats_your_name" },
        { type: "constant", value: " " },
      ],
    };

    const qa = [["whats_your_name", "baz"]];
    const qa2 = [["whats_your_name", " "]];

    f.getCondition({ form }, qa, "whats_your_name", cond).should.be.true;
    f.getCondition({ form }, qa, "whats_your_name", { ...cond, op: "is_not" })
      .should.be.true;
    f.getCondition({ form }, qa, "whats_your_name", { ...cond, op: "is" })
      .should.be.false;
    f.getCondition({ form }, qa, "whats_your_name", { ...cond, op: "equal" })
      .should.be.false;
    f.getCondition({ form }, qa2, "whats_your_name", cond).should.be.false;
    f.getCondition({ form }, qa2, "whats_your_name", { ...cond, op: "equal" })
      .should.be.true;
  });

  it("works with number equals and not equals is and is not - casts types from strings", () => {
    const cond = {
      op: "is",
      vars: [
        { type: "field", value: "baz" },
        { type: "constant", value: 10 },
      ],
    };

    const qa = [["baz", "10"]];

    f.getCondition({ form }, qa, "", cond).should.be.true;
    f.getCondition({ form }, qa, "", { ...cond, op: "equal" }).should.be.true;
    f.getCondition({ form }, qa, "", { ...cond, op: "is_not" }).should.be.false;
    f.getCondition({ form }, qa, "", { ...cond, op: "not_equal" }).should.be
      .false;
  });

  it("works with number not equals - type casting!", () => {
    const cond = {
      op: "is",
      vars: [
        { type: "field", value: "baz" },
        { type: "constant", value: 10 },
      ],
    };

    const qa = [["baz", "11"]];

    f.getCondition({ form }, qa, "", cond).should.be.false;
  });

  it("works with lower_equal_than operator on numbers", () => {
    const cond = {
      op: "lower_equal_than",
      vars: [
        { type: "field", value: "baz" },
        { type: "constant", value: 10 },
      ],
    };

    const qa = [["baz", "10"]];

    f.getCondition({ form }, qa, "", cond).should.be.true;
    f.getCondition({ form }, qa, "", { ...cond, op: "greater_equal_than" })
      .should.be.true;
  });

  it('works with "and" and "or" operators', () => {
    const cond = {
      op: "and",
      vars: [
        {
          op: "is",
          vars: [
            {
              type: "field",
              value: "baz",
            },
            {
              type: "constant",
              value: true,
            },
          ],
        },
        {
          op: "is",
          vars: [
            {
              type: "field",
              value: "qux",
            },
            {
              type: "constant",
              value: true,
            },
          ],
        },
      ],
    };

    const qa = [
      ["baz", true],
      ["qux", true],
    ];
    const qa2 = [
      ["baz", true],
      ["qux", false],
    ];

    f.getCondition({ form }, qa, "", cond).should.be.true;
    f.getCondition({ form }, qa, "", { ...cond, op: "or" }).should.be.true;
    f.getCondition({ form }, qa2, "", cond).should.be.false;
    f.getCondition({ form }, qa2, "", { ...cond, op: "or" }).should.be.true;
  });
});

describe("jump", () => {
  it("makes jump when required and makes no jump when not", () => {
    const logic = form.logic[0];
    const qaGood = [["whats_your_name", "baz"]];
    const qaBad = [["whats_your_name", " "]];

    const yes = f.jump(form, qaGood, logic);
    yes.should.equal("how_is_your_day");

    const no = f.jump(form, qaBad, logic);
    no.should.equal("whats_your_age");
  });
});

describe("getNextField", () => {
  it("gets the next field in the form taking into account any logic jumps", () => {
    const ref = "whats_your_name";
    const qaGood = [[ref, "baz"]];
    const qaBad = [[ref, " "]];

    const yes = f.getNextField(form, qaGood, ref);
    yes.should.equal(form.fields[2]);

    const no = f.getNextField(form, qaBad, ref);
    no.should.equal(form.fields[1]);
  });

  it("gets the next field including any thankyou screens", () => {
    const ref = "how_is_your_day";
    const qaGood = [[ref, "Just OK..."]];
    const qaBad = [[ref, " "]];

    const yes = f.getNextField(form, qaGood, ref);
    yes.should.equal(form.fields[3]);

    const no = f.getNextField(form, qaBad, ref);
    no.should.equal(form.fields[3]);
  });
});

describe("translateForm", () => {
  it("forms one array of fields and thankyou screens", () => {
    const fields = sample.fields.length;
    const thankyouScreens = sample.thankyou_screens.length;

    const val = f.translateForm(sample).fields;
    val.length.should.equal(fields + thankyouScreens);
  });
});
