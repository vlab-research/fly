const { translator } = require("./translate-fields");
const phone = require("phone");
const emailValidator = require("email-validator");

const defaultMessages = {
  "label.error.mustEnter":
    "Sorry, that answer is not valid. Please try to answer the question again.",
  "label.error.mustSelect":
    "Sorry, please use the buttons provided to answer the question.",
  "label.error.range": "Sorry, please enter a valid number.",
  "label.error.phoneNumber": "Sorry, please enter a valid phone number.",
  "label.error.emailAddress": "Sorry, please enter a valid email address.",
};

function _validateMC(r, titles, messages) {
  // Messenger will return us numbers in JSON,
  // but typeform mostly uses strings, except for booleans.
  // So we cast everything to strings, to compare with QR's
  return {
    message: messages["label.error.mustSelect"],
    valid: titles.map(t => "" + t).indexOf("" + r) !== -1,
  };
}

function validateQR(field, messages) {
  const q = translator(field);
  const titles = q.quick_replies.map(r => r.title);
  return r => _validateMC(r, titles, messages);
}

function validateString(field, messages) {
  return r => ({
    message: messages["label.error.mustEnter"],
    valid: typeof r === "string",
  });
}

function isEmptyString(str) {
  if (!str.replace(/\s/g, "").length) {
    return true;
  }
  return false;
}

function validateStatement(field, messages) {
  // this could be made more generic, but enough for now.
  const { responseMessage } = field.md ? field.md : {};
  return __ => ({
    message: responseMessage || "No response is necessary.",
    valid: true,
  });
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

function _isEmail(mail) {
  return emailValidator.validate(mail);
}

function validateEmail(field, messages) {
  return r => ({
    message: messages["label.error.emailAddress"],
    valid: _isEmail(r),
  });
}

function _isPhone(number, country, mobile) {
  return !!phone("" + number, country, !mobile)[0];
}

function validatePhone(field, messages) {
  const q = translator(field);
  const md = JSON.parse(q.metadata);
  const country = md.validate && md.validate.country;
  const mobile = md.validate && md.validate.mobile;

  return r => ({
    message: messages["label.error.phoneNumber"],
    valid: _isPhone(r, country || "", mobile),
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
  number: validateNumber,
  statement: validateStatement,
  thankyou_screen: validateStatement,
  multiple_choice: validateQR,
  rating: validateQR,
  opinion_scale: validateQR,
  short_text: validateString,
  long_text: validateString,
  share: validateStatement,
  email: validateEmail,
  phone_number: validatePhone,
};

function validationMessages(messages = {}) {
  return { ...defaultMessages, ...messages };
}

function validator(field, messages = {}) {
  messages = validationMessages(messages);

  const fn = lookup[field.type];

  if (!fn) {
    return true;
  }
  return fn(field, messages);
}

module.exports = {
  validator,
  isNumber,
  isEmptyString,
  validateFieldValue,
};
