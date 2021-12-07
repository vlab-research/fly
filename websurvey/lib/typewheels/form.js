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

// should the second arg be ref instead of idx?
function getThankyouScreen(form, idx) {
  if (!form.thankyou_screens.length) {
    throw new FieldError(`This form has no thankyou screens: ${form.id}`);
  }

  const thankyouScreen = form.thankyou_screens[idx];

  if (idx > form.thankyou_screens.length) {
    throw new FieldError(`Could not find the requested thankyouscreen, at index ${idx},
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

function getNextRef(form, ref) {
  const idx = form.fields.map(({ ref }) => ref).indexOf(ref);
  return form.fields[idx + 1].ref;
}

module.exports = {
  isLast,
  getField,
  setFirstRef,
  getNextRef,
  getThankyouScreen,
};
