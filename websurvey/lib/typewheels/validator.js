const defaultMessages = {
  "label.error.mustEnter":
    "Sorry, that answer is not valid. Please try to answer the question again.",
  "label.error.range": "Sorry, please enter a valid number.",
};

function validationMessages(messages = {}) {
  return { ...defaultMessages, ...messages };
}

function validateString(field, messages) {
  return r => ({
    message: messages["label.error.mustEnter"],
    valid: typeof r === "string",
  });
}

function isNumber(num) {
  if (typeof num === "string") {
    num = num.replace(/,/g, "");
    num = num.replace(/\./g, "");
    num = num.trim();
    console.log(!!num && num * 0 === 0);
    return !!num && num * 0 === 0;
  }
  // This assumes that if it's not a string, it's a number.
  return true;
}

function validateNumber(field, messages) {
  return r => ({
    message: messages["label.error.range"],
    valid: isNumber(r),
  });
}

const lookup = {
  short_text: validateString,
  number: validateNumber,
};

function validator(field, messages = {}) {
  messages = validationMessages(messages);

  const fn = lookup[field.type];
  if (!fn) {
    throw new TypeError(
      `There is no translator for the question of type ${field.type}`
    );
  }
  return fn(field, messages);
}

module.exports = { validator, isNumber };
