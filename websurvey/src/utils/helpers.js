function isLast(fields, ref) {
  const index = fields.findIndex(field => field.ref === ref);
  return index === fields.length - 1;
}

function getIndex(fields, ref) {
  const index = fields.findIndex(field => field.ref === ref);
  return index;
}

function getNextRef(fields, ref) {
  const index = fields.findIndex(field => field.ref === ref);
  return fields[index + 1].ref;
}

module.exports = {
  isLast,
  getIndex,
  getNextRef,
};
