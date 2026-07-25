import { hasActionFindings, destToUrl } from './healthNav';

const MONITOR_URL = '/surveys/My%20Survey/monitor';

describe('hasActionFindings (badge logic)', () => {
  it('is false for null/empty findings', () => {
    expect(hasActionFindings(null)).toBe(false);
    expect(hasActionFindings([])).toBe(false);
  });

  it('is false when only notes are present — notes do not light the badge', () => {
    expect(hasActionFindings([{ level: 'note' }, { level: 'note' }])).toBe(false);
  });

  it('is true when any action finding is present', () => {
    expect(hasActionFindings([{ level: 'note' }, { level: 'action' }])).toBe(true);
  });
});

describe('destToUrl (action -> URL mapping)', () => {
  it('maps states-list with a filter to the list URL with query params', () => {
    const action = { label: 'View', dest: 'states-list', filter: { state: 'ERROR' } };
    expect(destToUrl(action, MONITOR_URL)).toBe(`${MONITOR_URL}/list?state=ERROR`);
  });

  it('maps states-list with an empty filter to the bare list URL', () => {
    const action = { label: 'View', dest: 'states-list', filter: {} };
    expect(destToUrl(action, MONITOR_URL)).toBe(`${MONITOR_URL}/list`);
  });

  it('drops empty filter values', () => {
    const action = { label: 'View', dest: 'states-list', filter: { state: '', form: 'ABC' } };
    expect(destToUrl(action, MONITOR_URL)).toBe(`${MONITOR_URL}/list?form=ABC`);
  });

  it('maps message-templates to the MessageTemplates route', () => {
    const action = { label: 'Check templates', dest: 'message-templates' };
    expect(destToUrl(action, MONITOR_URL)).toBe('/message-templates');
  });

  it('returns null for unknown dests (message renders without a link)', () => {
    const action = { label: 'X', dest: 'some-future-dest' };
    expect(destToUrl(action, MONITOR_URL)).toBeNull();
    expect(destToUrl(null, MONITOR_URL)).toBeNull();
    expect(destToUrl({}, MONITOR_URL)).toBeNull();
  });
});
