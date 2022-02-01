const yaml = require("js-yaml");

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

function getThankyouScreen(form, ref) {
  if (!form.thankyou_screens.length) {
    throw new FieldError(`This form has no thankyou screens: ${form.id}`);
  }

  const idx = form.thankyou_screens.map(({ ref }) => ref).indexOf(ref);
  const thankyouScreen = form.thankyou_screens[idx];

  if (!thankyouScreen) {
    throw new FieldError(`Could not find the requested thankyouscreen, ${ref},
                          in our form: ${form.id}!`);
  }

  return thankyouScreen;
}

function isLast(form, ref) {
  const idx = form.fields.map(({ ref }) => ref).indexOf(ref);
  return idx === form.fields.length - 1;
}

function setFirstRef(form, idx) {
  return form.fields[idx].ref;
}

function getNext(form, ref) {
  if (isLast(form, ref)) {
    return null;
  }

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
  const ans = match && match[1];
  return ans ? ans : null;
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

module.exports = {
  isLast,
  getField,
  setFirstRef,
  getThankyouScreen,
  getNextField,
  getNext,
  jump,
  getFieldValue,
  getChoiceValue,
  getVar,
  getCondition,
};
