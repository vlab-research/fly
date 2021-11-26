export default function getNextRef(fields, ref) {
  const index = fields.findIndex(field => field.ref === ref);
  return fields[index + 1].ref;
}
