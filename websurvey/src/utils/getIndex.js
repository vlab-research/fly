export default function getIndex(fields, currentRef) {
  const index = fields.findIndex(({ ref }) => ref === currentRef);
  return index;
}
