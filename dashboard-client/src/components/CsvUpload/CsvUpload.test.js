import { parseCSV } from './CsvUpload';

// Exodus resolves a user_list bail's platform from the account's credential, so
// the sheet is fixed at 3 columns. A researcher who adds a 4th `platform` column
// needs the error to say why, not just that the count is wrong.
describe('parseCSV', () => {
  it('parses valid rows without a header', () => {
    const csv = 'user1,page1,short1\nuser2,page2,short2';
    const { users, errors } = parseCSV(csv);
    expect(errors).toEqual([]);
    expect(users).toEqual([
      { userid: 'user1', pageid: 'page1', shortcode: 'short1' },
      { userid: 'user2', pageid: 'page2', shortcode: 'short2' },
    ]);
  });

  it('skips a recognized header row', () => {
    const csv = 'userid,pageid,shortcode\nuser1,page1,short1';
    const { users, errors } = parseCSV(csv);
    expect(errors).toEqual([]);
    expect(users).toEqual([{ userid: 'user1', pageid: 'page1', shortcode: 'short1' }]);
  });

  it('rejects a 4-column row and explains platform is resolved automatically', () => {
    const csv = 'user1,page1,short1,messenger';
    const { users, errors } = parseCSV(csv);
    expect(users).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^Row 1: expected 3 columns \(userid, pageid, shortcode\), got 4/);
    expect(errors[0]).toMatch(/platform is resolved automatically/i);
    expect(errors[0]).toMatch(/cannot be set in the CSV/i);
  });

  it('reports the correct row number for a bad row past the header', () => {
    const csv = 'userid,pageid,shortcode\nuser1,page1,short1\nuser2,page2,short2,whatsapp';
    const { errors } = parseCSV(csv);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^Row 3: expected 3 columns/);
  });

  it('flags empty required fields', () => {
    const csv = ',page1,short1\nuser2,,short2\nuser3,page3,';
    const { users, errors } = parseCSV(csv);
    expect(users).toEqual([]);
    expect(errors).toEqual([
      'Row 1: userid is empty',
      'Row 2: pageid is empty',
      'Row 3: shortcode is empty',
    ]);
  });

  it('skips blank lines', () => {
    const csv = 'user1,page1,short1\n\nuser2,page2,short2\n';
    const { users, errors } = parseCSV(csv);
    expect(errors).toEqual([]);
    expect(users).toHaveLength(2);
  });
});
