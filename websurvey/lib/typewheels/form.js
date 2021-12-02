class FieldError extends Error {}

function getField({ form }, ref) {
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

function getFieldResponse(qa, ref) {
  // return last valid answer
  const match = qa.filter(([q, __]) => q === ref).pop();
  // return null if there are no matches,
  // or if there are no answers,
  const answer = match && match[1];
  return answer ? answer : null;
}

function getIndex({ form }, ref) {
  if (!form.fields.length) {
    throw new FieldError(`This form has no fields: ${form.id}`);
  }

  const idx = form.fields.map(({ ref }) => ref).indexOf(ref);
  const field = form.fields[idx];

  if (!field) {
    throw new FieldError(`Could not find the requested field, ${ref},
                          in our form: ${form.id}`);
  }
  return idx;
}

function isLast(fields, ref) {
  const index = fields.findIndex(field => field.ref === ref);
  return index === fields.length - 1;
}

function getNextRef(fields, ref) {
  const index = fields.findIndex(field => field.ref === ref);
  return fields[index + 1].ref;
}

function getNextField(fields, ref) {
  if (isLast(fields, ref)) {
    return null;
  }

  const index = fields.findIndex(field => field.ref === ref);
  return fields[index + 1];
}

function getNextFieldWithLogic(data, field) {
  const logic =
    data.logic && data.logic.find(logicItem => logicItem.ref === field.ref);

  if (logic) {
    const next = jump(data, logic);
    const field = getField(fields, next);
    return field;
  }

  return getNextField(data, field);
}

function jump(data, logic) {
  const { ref, actions } = logic;

  for (let { condition, details } of actions) {
    if (getCondition(data, ref, condition)) {
      return details.to.value;
    }
  }

  // Default to next field if none found
  return getNextRef(fields, ref);
}

module.exports = {
  getFieldResponse,
  isLast,
  getIndex,
  getNextRef,
  getField,
  getNextField,
  getNextFieldWithLogic,
};
