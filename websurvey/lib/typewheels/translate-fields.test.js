const mocha = require("mocha");
const chai = require("chai").should();
const mocks = require("./mocks/sample.json");

const translateFunctions = require("./translate-fields");

describe("should translate multiple choice questions", () => {
  const multipleChoiceQuestion = mocks.fields.filter(question => {
    return question.type === "multiple_choice";
  })[0];

  const translated = translateFunctions.translator(multipleChoiceQuestion);

  it("should have a text property with the title of the questions", () => {
    translated.should.have.property("text", multipleChoiceQuestion.title);
  });
  it("quick_replies should be an array with 3 elements in it", () => {
    translated.quick_replies.should.be.an("array");
    translated.quick_replies.should.have.length(3);
  });
  it('quick_replies should have "content-type", "title", "payload" properties', () => {
    translated.quick_replies
      .every(reply => {
        if (reply.content_type && reply.title && reply.payload) {
          return true;
        }
      })
      .should.equal(true);
  });
  it("quick_replies should have the proper payload and titles", () => {
    const values = translated.quick_replies
      .map(r => JSON.parse(r.payload))
      .map(r => r.value);
    values.should.deep.equal(["Commander", "Astro-biologist", "Engineer"]);
    const titles = translated.quick_replies.map(r => r.title);
    titles.should.deep.equal(["Commander", "Astro-biologist", "Engineer"]);
  });
});

describe("should translate questions that use an opinion scale", () => {
  const opinionScaleQuestion = mocks.fields.filter(question => {
    return question.type === "opinion_scale";
  })[0];

  const translated = translateFunctions.translateOpinionScale(
    opinionScaleQuestion,
    "foo"
  );

  it("should have a text property with the title of the questions", () => {
    translated.should.have.property("text", opinionScaleQuestion.title);
  });

  it("quick_replies should have number of elements equal to steps", () => {
    translated.quick_replies.should.be.an("array");
    translated.quick_replies.should.have.length(
      opinionScaleQuestion.properties.steps
    );
  });

  it("quick_replies payload property should return the score and ref", () => {
    for (let [index, el] of translated.quick_replies.entries()) {
      JSON.parse(el.payload).value.should.equal("" + (index + 1));
      JSON.parse(el.payload).ref.should.equal("foo");
      el.title.should.equal("" + (index + 1));
      el.content_type.should.equal("text");
    }
  });

  it("quick_replies payload property should listen to start_at_one", () => {
    const translated = translateFunctions.translateOpinionScale({
      ...opinionScaleQuestion,
      properties: { steps: 5, start_at_one: false },
    });

    for (let [index, el] of translated.quick_replies.entries()) {
      JSON.parse(el.payload).value.should.equal("" + index);
      el.title.should.equal("" + index);
      el.content_type.should.equal("text");
    }
  });

  it("quick_replies payload property should default to 1 if start_at_one is undefined (translateRating)", () => {
    const translated = translateFunctions.translateRatings({
      ...opinionScaleQuestion,
      properties: { steps: 5, start_at_one: undefined },
    });

    for (let [index, el] of translated.quick_replies.entries()) {
      JSON.parse(el.payload).value.should.equal("" + (index + 1));
      el.title.should.equal("" + (index + 1));
      el.content_type.should.equal("text");
    }
  });
});
