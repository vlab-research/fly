export default function isLast(fields, ref) {
  const index = fields.findIndex(field => field.ref === ref);
  return index === fields.length - 1;
}
