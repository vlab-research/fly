const defaultMessages = {
  "label.error.mustEnter":
    "Sorry, that answer is not valid. Please try to answer the question again.",
  "label.error.range": "Sorry, please enter a valid number.",
};

function validationMessages(messages = {}) {
  return { ...defaultMessages, ...messages };
}

function isNumber(num) {
  if (typeof num === "string") {
    num = num.replace(/,/g, "");
    num = num.replace(/\./g, "");
    num = num.trim();
    return !!num && num * 0 === 0; // false
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

// included to prevent numbers being submitted where strings are required
function isString(str) {
  if (typeof str === "string" && !isNumber(str)) {
    return true;
  }
  return false;
}

function isEmptyString(str) {
  if (!str.replace(/\s/g, "").length) {
    return true;
  }
  return false;
}

function validateString(field, messages) {
  return r => ({
    message: messages["label.error.mustEnter"],
    valid: isString(r),
  });
}

function validateFieldValue(field, fieldValue) {
  const res = validator(field)(fieldValue);

  if (!res.valid) {
    return false;
  }
  return true;
}

const lookup = {
  short_text: validateString,
  number: validateNumber,
  multiple_choice: validateString,
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

module.exports = {
  validator,
  isNumber,
  isString,
  isEmptyString,
  validateFieldValue,
};
