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
    const firstToken = "1970-01-01 00:00:00+00:00/''/''";
    return firstToken.split('/');
  }

  getToken(timestamp, userid, ref) {
    const rawToken = this.rawToken(timestamp, userid, ref);
    return encode(rawToken);
  }
}

module.exports = { Token };
