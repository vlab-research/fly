const base64 = require('base-64');
const decode = base64.decode;
const encode = base64.encode;

class Token {
  rawToken(timestamp, userid, ref) {
    return `${timestamp}/${userid}/${ref}`;
  }

  encode(rawToken) {
    return encode(rawToken);
  }

  decode(encodedStr) {
    const decoded = decode(encodedStr);
    var [timestamp, userid, ref] = decoded.split('/');
    return [timestamp, userid, ref];
  }

  default() {
    const firstToken = `${new Date('1970-01-01')}/ ''/ ''`;
    return firstToken.split('/');
  }
}

module.exports = { Token };
