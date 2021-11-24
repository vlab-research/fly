export default function getField(fields, ref) {
  // TODO error handling
  const index = fields.map(({ ref }) => ref).indexOf(ref);
  const field = fields[index];
  return field;
}
