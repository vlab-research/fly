const token = require('./token');

const timestamps = {
  1: '2022-06-06 09:58:00+00:00',
  2: '2022-06-06 10:00:00+00:00',
  3: '2022-06-06 10:02:00+00:00',
};
const userid = '126';
const ref = 'ref';

describe('Token', () => {
  describe('encode', () => {
    const values = [timestamps[1], userid, ref];
    const encodedToken = token.encoded(values);

    const values2 = [timestamps[2], userid, ref];
    const encodedToken2 = token.encoded(values2);

    it('returns a unique token', () => {
      encodedToken.should.equal('MjAyMi0wNi0wNiAwOTo1ODowMCswMDowMCwxMjYscmVm');
      encodedToken2.should.equal(
        'MjAyMi0wNi0wNiAxMDowMDowMCswMDowMCwxMjYscmVm',
      );
      encodedToken2.should.not.equal(encodedToken);
    });

    describe('decode', () => {
      const decodedToken = token.decoded(encodedToken);
      const decodedToken2 = token.decoded(encodedToken2);

      it('decodes a token into three readable values', () => {
        decodedToken.should.eql(['2022-06-06 09:58:00+00:00', '126', 'ref']);
        decodedToken2.should.eql(['2022-06-06 10:00:00+00:00', '126', 'ref']);
      });

      it('when reversed it decodes to the same three values', () => {
        const encodedToken = token.encoded(decodedToken);
        encodedToken.should.equal(encodedToken);
        token
          .decoded(encodedToken)
          .should.eql(['2022-06-06 09:58:00+00:00', '126', 'ref']);

        const encodedToken2 = token.encoded(decodedToken2);
        encodedToken2.should.equal(encodedToken2);
        token
          .decoded(encodedToken2)
          .should.eql(['2022-06-06 10:00:00+00:00', '126', 'ref']);
      });
    });
  });
});
