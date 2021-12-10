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

function jump(form, qa, logic) {
  const { ref, actions } = logic;

  for (let { condition, details } of actions) {
    if (getCondition(form, qa, ref, condition)) {
      return details.to.value;
    }
  }

  // Default to next field if none found
  return getNext(form, ref).ref;
}

module.exports = {
  isLast,
  getField,
  setFirstRef,
  getThankyouScreen,
  getNextField,
  getNext,
};
