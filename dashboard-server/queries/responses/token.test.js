const t = require('./token');
const token = new t.Token();

const timestamps = {
  1: '2022-06-06 09:58:00+00:00',
  2: '2022-06-06 10:00:00+00:00',
  3: '2022-06-06 10:02:00+00:00',
};
const userid = '126';
const ref = 'ref';

describe('default', () => {
  it('returns a default timestamp, userid and ref', () => {
    var [timestamp, userid, ref] = token.default();

    timestamp.should.equal('1970-01-01 00:00:00+00:00');
    userid.should.equal("''");
    ref.should.equal("''");
  });
});

describe('encode', () => {
  it('returns an encoded token', () => {
    const timestamp = timestamps[1];
    const rawToken = token.rawToken(timestamp, userid, ref);
    const encodedToken = token.encode(rawToken);
    encodedToken.should.equal(encodedToken);
  });

  it('encodes the first default token', () => {
    var [timestamp, userid, ref] = token.default();
    const rawToken = token.rawToken(timestamp, userid, ref);
    const encodedToken = token.encode(rawToken);
    encodedToken.should.not.equal(rawToken);
  });
});

describe('decode', () => {
  it('decodes a token into three readable values', () => {
    const timestamp = timestamps[1];
    const rawToken = token.rawToken(timestamp, userid, ref);
    const encodedToken = token.encode(rawToken);
    const decodedToken = token.decode(encodedToken);
    decodedToken.should.equal(decodedToken);
    decodedToken.should.have.length(3);
  });
});

describe('getToken', () => {
  it('returns a token from three values', () => {
    const timestamp = timestamps[1];
    const getToken = token.getToken(timestamp, userid, ref);
    getToken.should.equal('MjAyMi0wNi0wNiAwOTo1ODowMCswMDowMC8xMjYvcmVm');
  });
});
