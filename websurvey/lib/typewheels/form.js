const yaml = require("js-yaml");
const Mustache = require("mustache");
const _ = require("lodash");

class FieldError extends Error {}

function getField(form, ref) {
  if (!form.fields.length) {
    throw new FieldError(`This form has no fields: ${form.id}`);
  }

  const idx = form.fields.map(({ ref }) => ref).indexOf(ref);
  const field = form.fields[idx];

  if (!field) {
    throw new FieldError(`Could not find the requested field, ${ref},
                          in our form: ${form.id}!`);
  }
  return field;
}

function setFirstRef(form, idx) {
  return form.fields[idx].ref;
}

function getNext(form, ref) {
  const idx = form.fields.map(({ ref }) => ref).indexOf(ref);
  return form.fields[idx + 1];
}

function getNextField(form, qa, ref) {
  const logic = form.logic && form.logic.find(logic => logic.ref === ref);

  if (logic) {
    const nxt = jump(form, qa, logic);
    const field = getField(form, nxt);
    return field;
  }
  return getNext(form, ref);
}

function getChoiceValue(form, ref, choice) {
  const val = form.fields
    .find(f => f.ref === ref)
    .properties.choices.find(c => c.ref === choice.ref).label;

  if (!val) {
    throw new TypeError(
      `Could not find value for choice: ${choice} in question ${ref}`
    );
  }

  return val;
}

const funs = {
  and: (a, b) => a && b,
  or: (a, b) => a || b,
  greater_than: (a, b) => a > b,
  lower_than: (a, b) => a < b,
  greater_equal_than: (a, b) => a >= b,
  lower_equal_than: (a, b) => a <= b,
  is: (a, b) => a === b,
  equal: (a, b) => a === b,
  is_not: (a, b) => a !== b,
  not_equal: (a, b) => a !== b,
};

function getCondition(ctx, qa, ref, { op, vars }) {
  if (op === "always") return true;

  const f = funs[op];

  if (!f) {
    throw new TypeError(`Cannot find operation: ${op}\nquestion: ${ref}`);
  }

  const fn = (a, b) => f(yaml.load(a), yaml.load(b));

  return vars.map(v => getVar(ctx, qa, ref, vars, v)).reduce(fn);
}

function jump(ctx, qa, logic) {
  const { ref, actions } = logic;

  for (let { condition, details } of actions) {
    if (getCondition(ctx, qa, ref, condition)) {
      return details.to.value;
    }
  }

  // Default to next field if none found
  return getNext(ctx, ref).ref;
}

function getFieldValue(qa, ref) {
  // returns the last valid answer
  const match = qa.filter(([q, __]) => q === ref).pop();

  // return null if there are no matches,
  // or if there are no answers,
  // otherwise return match even if empty string

  if (!match) {
    return null;
  } else {
    return match[1];
  }
}

function getVar(ctx, qa, ref, vars, v) {
  // ops can be nested in a var
  if (v.op) {
    return getCondition(ctx, qa, ref, v);
  }

  const { type, value } = v;

  if (type === "constant") {
    return value;
  }

  if (type === "choice") {
    const field = vars.find(v => v.type === "field").value;
    return getChoiceValue(ctx, field, value);
  }

  if (type === "field") {
    return getFieldValue(qa, value);
  }
}

function translateForm(form) {
  const f = { ...form };
  f.fields = [
    ...f.fields,
    ...f.thankyou_screens.map(s => ({
      ...s,
      type: "thankyou_screen",
    })),
  ];

  return f;
}

function filterFields(form) {
  return form.fields.filter(field => field.type !== "thankyou_screen");
}

function _splitUrls(s) {
  const re = RegExp(/https?:\/\/[^\s]+/gi);
  const nonMatches = s.split(re).map(s => ["text", s]);
  return nonMatches;
}

function getDynamicValue(qa, title) {
  const regex = /:(.*)}}/;
  const match = title.match(regex) ? title.match(regex) : false;
  const ref = match ? match[1] : false;

  const fieldValue = getFieldValue(qa, ref);

  if (!match) {
    return false;
  }

  if (!fieldValue) {
    throw new TypeError(
      `Trying to interpolate a non-existent field value: ${title}`
    );
  }

  return fieldValue;
}

function _interpolate(qa, title) {
  const titledParsed = Mustache.parse(title);

  title = titledParsed
    .map(t =>
      t[0] === "name" ? t[1].replace(t[1], getDynamicValue(qa, title)) : t[1]
    )
    .join("");

  return title;
}

function interpolateField(qa, field) {
  const keys = ["title", "properties.description"];
  const out = { ...field };

  keys.forEach(k => _.set(out, k, _interpolate(qa, _.get(out, k))));

  return out;
}

function filterFieldTypes(form) {
  const fields = form.fields.map(field => field.type);
  const excludedTypes = ["thankyou_screen", "statement"];

  const filterArray = (fields, excludedTypes) => {
    const filtered = fields.filter(field => {
      return excludedTypes.indexOf(field) === -1;
    });
    return filtered;
  };
  return filterArray(fields, excludedTypes);
}

function isAQuestion(form, field) {
  const fields = filterFieldTypes(form);
  return fields.includes(field.type);
}

function isLast(form, ref) {
  const field = getField(form, ref);
  if (field.type === "thankyou_screen") {
    return true;
  }
  return false;
}

module.exports = {
  getField,
  setFirstRef,
  getNextField,
  getNext,
  jump,
  getFieldValue,
  getChoiceValue,
  getVar,
  getCondition,
  translateForm,
  filterFields,
  interpolateField,
  _splitUrls,
  _interpolate,
  getDynamicValue,
  filterFieldTypes,
  isAQuestion,
  isLast,
};
