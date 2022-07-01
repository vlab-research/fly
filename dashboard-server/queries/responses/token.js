const base64 = require('base-64');
const decode = base64.decode;
const encode = base64.encode;

class Token {
  encode(arr) {
    const values = arr.join(',');
    return encode(values);
  }

  decode(encodedStr) {
    const decoded = decode(encodedStr);
    var [timestamp, userid, ref] = decoded.split(',');
    return [timestamp, userid, ref];
  }
}

module.exports = { Token };
