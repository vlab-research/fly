export default function getNextField(fields, currentRef) {
  // TODO: work out ending logic
  const index = fields.findIndex(({ ref }) => ref === currentRef);
  return fields[index + 1];
}
