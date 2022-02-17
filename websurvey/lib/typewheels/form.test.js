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
    const field = form.fields[0];
    const nextField = form.fields[1];
    const value = f.getNext(form, field.ref);
    value.should.equal(nextField);
  });

  it("gets the first thankyou screen after the last question", () => {
    const value = f.getNext(form, "whats_your_age");
    value.ref.should.equal("thankyou");
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

  it("returns an empty string if the field exists but no answer is given", () => {
    const qa = [["foo", ""]];
    const value = f.getFieldValue(qa, "foo");
    value.should.equal("");
  });
});

describe("getChoiceValue", () => {
  it("gets the value of the selected multiple choice field", () => {
    const ctx = form;
    const ref = "how_is_your_day";
    const choice = "67554758-9085-45b8-b658-46e5b9686361";

    const value = f.getChoiceValue(ctx, ref, choice);
    value.should.equal("Just OK...");
  });
});

describe("getVar", () => {
  it("gets the field value depending on the var type", () => {
    const ctx = form;
    const qa = [["how_is_your_day", "Terrific!"]];
    const ref = "how_is_your_day";
    const vars = [
      {
        type: "field",
        value: "how_is_your_day",
      },
      {
        type: "choice",
        value: "c8c780a6-4210-4673-bf07-4130efde9151",
      },
    ];
    const v = vars[0];
    let value = f.getVar(ctx, qa, ref, vars, v);
    value.should.equal("Terrific!");

    const v2 = vars[1];
    value = f.getVar(ctx, qa, ref, vars, v2);
    value.should.equal("Terrific!");
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

  it("works with string equals", () => {
    const cond = {
      op: "equal",
      vars: [
        { type: "field", value: "whats_your_name" },
        { type: "constant", value: "baz" },
      ],
    };

    const ref = "whats_your_name";

    const qaGood = [["whats_your_name", "baz"]];
    const qaBad = [["whats_your_name", ""]];

    f.getCondition({ form }, qaGood, ref, cond).should.be.true;
    f.getCondition({ form }, qaGood, ref, { ...cond, op: "is" }).should.be.true;
    f.getCondition({ form }, qaBad, ref, cond).should.be.false;
    f.getCondition({ form }, qaBad, ref, { ...cond, op: "is_not" }).should.be
      .true;
  });

  it("works with string not equals", () => {
    const cond = {
      op: "not_equal",
      vars: [
        { type: "field", value: "whats_your_name" },
        { type: "constant", value: "" },
      ],
    };

    const ref = "whats_your_name";

    const qaGood = [["whats_your_name", "baz"]];
    const qaBad = [["whats_your_name", ""]];

    f.getCondition({ form }, qaGood, ref, cond).should.be.true;
    f.getCondition({ form }, qaGood, ref, { ...cond, op: "is" }).should.be
      .false;
    f.getCondition({ form }, qaBad, ref, cond).should.be.false;
    f.getCondition({ form }, qaBad, ref, { ...cond, op: "is_not" }).should.be
      .false;
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

    const qaGood = [["how_is_your_day", "Terrific!"]];
    const qaBad = [["how_is_your_day", "Just OK..."]];

    const yes = f.jump(form, qaGood, logic);
    yes.should.equal("awesome");

    const no = f.jump(form, qaBad, logic);
    no.should.equal("oh_no");
  });
});

describe("getNextField", () => {
  it("gets the next field in the form taking into account any logic jumps", () => {
    const ref = "how_is_your_day";
    const qaGood = [["how_is_your_day", "Terrific!"]];
    const qaBad = [["how_is_your_day", "Just OK.."]];

    const yes = f.getNextField(form, qaGood, ref);
    yes.ref.should.equal("awesome");

    const no = f.getNextField(form, qaBad, ref);
    no.ref.should.equal("oh_no");
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

describe("_splitUrls", () => {
  it("works with no url", () => {
    const split = f._splitUrls("hello baz");
    split.should.deep.equal([["text", "hello baz"]]);
  });
});

describe("getDynamicValue", () => {
  it("returns the field value of a previously answered question", () => {
    const qa = [["whats_your_name", "baz"]];
    const title =
      "Nice to meet you, {{field:whats_your_name}}, how is your day going?";
    const i = f.getDynamicValue(qa, title);
    i.should.equal("baz");
  });

  it("returns false if there is no dynamic value to interpolate", () => {
    const qa = [["whats_your_name", "baz"]];
    const title = "How old are you?";
    const i = f.getDynamicValue(qa, title);
    i.should.equal(false);
  });

  it("throws if an invalid field value is found", () => {
    const qa = [["whats_your_name", ""]];
    const title =
      "Nice to meet you, {{field:whats_your_name}}, how is your day going?";
    const fn = () => f.getDynamicValue(qa, title);
    fn.should.throw(
      /Nice to meet you, {{field:whats_your_name}}, how is your day going/
    ); // title
  });
});

describe("_interpolate", () => {
  it("interpolates a field with a dynamic value", () => {
    const qa = [["whats_your_name", "baz"]];
    const title =
      "Nice to meet you, {{field:whats_your_name}}, how is your day going?";
    const i = f._interpolate(qa, title);
    i.should.equal("Nice to meet you, baz, how is your day going?");
  });
});

describe("interpolateField", () => {
  const qa = [["whats_your_name", "baz"]];
  const field = {
    type: "multiple_choice",
    title:
      "Nice to meet you, {{field:whats_your_name}}, how is your day going?",
    ref: "how_is_your_day",
  };

  it("works with previously answered fields", () => {
    const i = f.interpolateField(qa, field);
    i.title.should.equal("Nice to meet you, baz, how is your day going?");
  });

  it("works when there is no dynamic value", () => {
    const qa = [["whats_your_name", "baz"]];
    const field = {
      type: "multiple_choice",
      title: "Nice to meet you, how is your day going?",
      ref: "how_is_your_day",
    };

    const i = f.interpolateField(qa, field);
    i.title.should.equal("Nice to meet you, how is your day going?");
  });
});

describe("filterFieldTypes", () => {
  it("returns an array of question types only", () => {
    const value = f.filterFieldTypes(form);
    value.should.eql(["short_text", "multiple_choice", "number"]);
  });
});

describe("isAQuestion", () => {
  it("returns true if field is a question", () => {
    const field = {
      ref: "whats_your_name",
      type: "short_text",
    };
    const value = f.isAQuestion(form, field);
    value.should.be.true;
  });

  it("returns false if field is not question", () => {
    const field = {
      ref: "thankyou",
      type: "thankyou_screen",
    };
    const value = f.isAQuestion(form, field);
    value.should.be.false;
  });
});

describe("isLast", () => {
  it("returns true if field is last in the form", () => {
    const ref = "thankyou";
    const value = f.isLast(form, ref);
    value.should.be.true;
  });

  it("returns false if field is not question", () => {
    const field = {
      ref: "thankyou",
      type: "thankyou_screen",
    };
    const value = f.isAQuestion(form, field);
    value.should.be.false;
  });
});
