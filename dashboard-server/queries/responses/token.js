const base64 = require('base-64');
const decode = base64.decode;
const encode = base64.encode;

const encoded = arr => {
  const values = arr.join(',');
  return encode(values);
};

const decoded = encodedStr => {
  var [timestamp, userid, ref] = decode(encodedStr).split(',');
  return [timestamp, userid, ref];
};

module.exports = { encoded, decoded };
