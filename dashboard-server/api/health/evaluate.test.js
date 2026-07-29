'use strict';

require('chai').should();

const { buildAggregates } = require('./aggregate');
const { evaluate } = require('./evaluate');
const { rules } = require('./rules');

// Silent warn so expected unknown-metric tests don't pollute output.
const quiet = () => {};

// Convenience: a bag shaped like buildAggregates output, with overrides.
function bag(overrides = {}) {
  return Object.assign(
    {
      window_hours: 24,
      active_users: 0,
      error: { platform: 0, study: 0, by_tag: {} },
      // Mirrors FB_CATEGORIES in aggregate.js. evaluate() SKIPS a rule whose
      // metric is absent from the bag, so a category missing here makes its
      // rule silently untestable — keep in sync.
      blocked: {
        attrition: 0,
        template_missing: 0,
        rate_limit: 0,
        unsupported: 0,
        provider_error: 0,
        provider_unreachable: 0,
        other: 0,
      },
      stuck_users: 0,
      expired_waits: 0,
      by_form: {},
    },
    overrides
  );
}

describe('health evaluate (pure rule engine)', () => {
  it('returns no findings for an empty bag', () => {
    evaluate(bag(), rules, quiet).should.deep.equal([]);
  });

  it('fires action at count=1 for deterministic blockers (template_missing)', () => {
    const b = bag({
      active_users: 1000,
      blocked: {
        attrition: 0,
        template_missing: 1,
        rate_limit: 0,
        unsupported: 0,
        other: 0,
      },
    });
    const findings = evaluate(b, rules, quiet);
    findings.length.should.equal(1);
    findings[0].id.should.equal('template-missing');
    findings[0].level.should.equal('action');
    findings[0].count.should.equal(1);
    findings[0].message.should.contain('1 respondent(s) blocked');
    findings[0].action.dest.should.equal('message-templates');
  });

  it('fires action at count=1 for platform errors', () => {
    const b = bag({
      active_users: 500,
      error: { platform: 1, study: 0, by_tag: { INTERNAL: 1 } },
    });
    const findings = evaluate(b, rules, quiet);
    findings.length.should.equal(1);
    findings[0].id.should.equal('platform-errors');
    findings[0].level.should.equal('action');
  });

  it('yields a note, not an action, for stochastic 1-in-1000 errors', () => {
    const b = bag({
      active_users: 1000,
      error: { platform: 0, study: 1, by_tag: { none: 1 } },
    });
    const findings = evaluate(b, rules, quiet);
    findings.length.should.equal(1);
    findings[0].id.should.equal('error-trickle');
    findings[0].level.should.equal('note');
    findings[0].message.should.contain('0.1%');
  });

  it('spike supersedes trickle when proportion + floor are met', () => {
    const b = bag({
      active_users: 100,
      error: { platform: 0, study: 10, by_tag: { none: 10 } },
    });
    const findings = evaluate(b, rules, quiet);
    const errorFindings = findings.filter(f => f.action.filter && f.action.filter.state === 'ERROR');
    errorFindings.length.should.equal(1);
    errorFindings[0].id.should.equal('error-spike');
    errorFindings[0].level.should.equal('action');
    errorFindings[0].message.should.contain('10 of 100 respondents (10%)');
  });

  it('does not fire the spike below the absolute floor even at high ratio', () => {
    // 2 errors out of 10 = 20% ratio, but count < 3 -> trickle note only.
    const b = bag({
      active_users: 10,
      error: { platform: 0, study: 2, by_tag: { none: 2 } },
    });
    const findings = evaluate(b, rules, quiet);
    findings.length.should.equal(1);
    findings[0].id.should.equal('error-trickle');
    findings[0].level.should.equal('note');
  });

  it('attrition produces no findings (expected churn)', () => {
    // Built from the full default bag rather than a partial override, so this
    // genuinely proves attrition alone is silent instead of passing because
    // the other categories were absent and their rules got skipped.
    const b = bag({ active_users: 200 });
    b.blocked.attrition = 50;
    evaluate(b, rules, quiet).should.deep.equal([]);
  });

  it('fires action at count=1 for provider_unreachable, and does not promise recovery', () => {
    const b = bag({ active_users: 100 });
    b.blocked.provider_unreachable = 1;
    const findings = evaluate(b, rules, quiet);
    findings.should.have.length(1);
    findings[0].id.should.equal('provider-unreachable');
    findings[0].level.should.equal('action');
    // These respondents are structurally unrecoverable (dean's `= ANY` never
    // matches NULL) — copy must not tell the researcher to wait it out.
    findings[0].message.should.not.match(/automatic/i);
    findings[0].message.should.match(/contact support/i);
  });

  it('treats provider_error as stochastic: note on a trickle, action on a spike', () => {
    const trickle = bag({ active_users: 100 });
    trickle.blocked.provider_error = 2;
    const t = evaluate(trickle, rules, quiet);
    t.should.have.length(1);
    t[0].id.should.equal('provider-error-trickle');
    t[0].level.should.equal('note');

    const spike = bag({ active_users: 100 });
    spike.blocked.provider_error = 20;
    const s = evaluate(spike, rules, quiet);
    s.should.have.length(1);
    s[0].id.should.equal('provider-error-spike');
    s[0].level.should.equal('action');
  });

  it('does not fire the provider_error spike below the absolute floor', () => {
    // 2/5 = 40% ratio but only 2 respondents — the floor (3) must hold.
    const b = bag({ active_users: 5 });
    b.blocked.provider_error = 2;
    const findings = evaluate(b, rules, quiet);
    findings.should.have.length(1);
    findings[0].id.should.equal('provider-error-trickle');
  });

  it('surfaces every blocked category except attrition (no silent buckets)', () => {
    // Regression guard: before 2026-07-29 'other' and 'unsupported' were
    // classified but read by no rule, so a blocked respondent could produce a
    // completely clean Monitor tab.
    const silent = ['unsupported', 'other'];
    silent.forEach(category => {
      const b = bag({ active_users: 50 });
      b.blocked[category] = 1;
      const findings = evaluate(b, rules, quiet);
      findings.should.have.length(
        1,
        `blocked.${category} produced no finding — silent bucket regression`
      );
      findings[0].count.should.equal(1);
    });
  });

  it('sorts action findings before notes', () => {
    const b = bag({
      active_users: 1000,
      blocked: {
        attrition: 0,
        template_missing: 2,
        rate_limit: 0,
        unsupported: 0,
        other: 0,
      },
      stuck_users: 1,
      expired_waits: 1,
    });
    const findings = evaluate(b, rules, quiet);
    findings.length.should.equal(3);
    findings[0].level.should.equal('action');
    findings[0].id.should.equal('template-missing');
    findings.slice(1).forEach(f => f.level.should.equal('note'));
  });

  it('skips rules with unknown metrics and warns, without failing', () => {
    const warnings = [];
    const badRules = [
      {
        id: 'bogus',
        when: { metric: 'no.such.metric', count_gte: 1 },
        level: 'action',
        message: 'x',
        action: { label: 'x', dest: 'states-list', filter: {} },
      },
      ...rules,
    ];
    const b = bag({
      active_users: 100,
      stuck_users: 1,
    });
    const findings = evaluate(b, badRules, msg => warnings.push(msg));
    warnings.length.should.equal(1);
    warnings[0].should.contain('bogus');
    findings.length.should.equal(1);
    findings[0].id.should.equal('stuck-trickle');
  });

  it('clamps the ratio denominator so zero active users cannot divide by zero', () => {
    const b = bag({
      active_users: 0,
      error: { platform: 0, study: 1, by_tag: { none: 1 } },
    });
    const findings = evaluate(b, rules, quiet);
    findings.length.should.equal(1);
    findings[0].ratio.should.equal(1);
  });
});

describe('health buildAggregates (row folding)', () => {
  it('produces an empty bag with zeroed categories from no rows', () => {
    const b = buildAggregates([], 24);
    b.window_hours.should.equal(24);
    b.active_users.should.equal(0);
    b.error.platform.should.equal(0);
    b.error.study.should.equal(0);
    b.blocked.template_missing.should.equal(0);
    b.stuck_users.should.equal(0);
    b.expired_waits.should.equal(0);
    b.by_form.should.deep.equal({});
  });

  it('counts every row toward active_users regardless of state', () => {
    const rows = [
      { form: 'A', state: 'RESPONDING', error_tag: 'none', fb_category: 'other', stuck: 0, expired: 0, count: 10 },
      { form: 'A', state: 'END', error_tag: 'none', fb_category: 'other', stuck: 0, expired: 0, count: 5 },
      { form: 'B', state: 'ERROR', error_tag: 'none', fb_category: 'other', stuck: 0, expired: 0, count: 2 },
    ];
    buildAggregates(rows, 24).active_users.should.equal(17);
  });

  it('classifies platform vs study error tags, only for ERROR rows', () => {
    const rows = [
      { form: 'A', state: 'ERROR', error_tag: 'INTERNAL', fb_category: 'other', stuck: 0, expired: 0, count: 2 },
      { form: 'A', state: 'ERROR', error_tag: 'STATE_ACTIONS', fb_category: 'other', stuck: 0, expired: 0, count: 1 },
      { form: 'A', state: 'ERROR', error_tag: 'FORM_NOT_FOUND', fb_category: 'other', stuck: 0, expired: 0, count: 3 },
      { form: 'A', state: 'ERROR', error_tag: 'none', fb_category: 'other', stuck: 0, expired: 0, count: 4 },
      // error_tag on a non-ERROR row must not count as an error
      { form: 'A', state: 'BLOCKED', error_tag: 'FB', fb_category: 'attrition', stuck: 0, expired: 0, count: 5 },
    ];
    const b = buildAggregates(rows, 24);
    b.error.platform.should.equal(3);
    b.error.study.should.equal(7);
    b.error.by_tag.should.deep.equal({
      INTERNAL: 2,
      STATE_ACTIONS: 1,
      FORM_NOT_FOUND: 3,
      none: 4,
    });
  });

  it('defaults unknown error tags to study, and NULL tag to none', () => {
    const rows = [
      { form: 'A', state: 'ERROR', error_tag: 'VALIDATION_ERROR', fb_category: 'other', stuck: 0, expired: 0, count: 1 },
      { form: 'A', state: 'ERROR', error_tag: null, fb_category: 'other', stuck: 0, expired: 0, count: 2 },
    ];
    const b = buildAggregates(rows, 24);
    b.error.platform.should.equal(0);
    b.error.study.should.equal(3);
    b.error.by_tag.should.deep.equal({ VALIDATION_ERROR: 1, none: 2 });
  });

  it('buckets blocked categories only for BLOCKED rows, unknown categories to other', () => {
    const rows = [
      { form: 'A', state: 'BLOCKED', error_tag: 'none', fb_category: 'attrition', stuck: 0, expired: 0, count: 5 },
      { form: 'A', state: 'BLOCKED', error_tag: 'none', fb_category: 'template_missing', stuck: 0, expired: 0, count: 2 },
      { form: 'A', state: 'BLOCKED', error_tag: 'none', fb_category: 'weird-new-bucket', stuck: 0, expired: 0, count: 1 },
      // fb_category on a non-BLOCKED row is meaningless — ignored
      { form: 'A', state: 'RESPONDING', error_tag: 'none', fb_category: 'rate_limit', stuck: 0, expired: 0, count: 9 },
    ];
    const b = buildAggregates(rows, 24);
    b.blocked.attrition.should.equal(5);
    b.blocked.template_missing.should.equal(2);
    b.blocked.other.should.equal(1);
    b.blocked.rate_limit.should.equal(0);
  });

  it('buckets the provider categories the SQL CASE emits', () => {
    // Taxonomy contract site 2: FB_CATEGORIES is an allow-list, so a category
    // healthSummary emits but aggregate.js omits is silently folded into
    // 'other'. That is exactly how the 2026-07-26 drift stayed invisible.
    const rows = [
      { form: 'A', state: 'BLOCKED', error_tag: 'none', fb_category: 'provider_error', stuck: 0, expired: 0, count: 4 },
      { form: 'A', state: 'BLOCKED', error_tag: 'none', fb_category: 'provider_unreachable', stuck: 0, expired: 0, count: 7 },
    ];
    const b = buildAggregates(rows, 24);
    b.blocked.provider_error.should.equal(4);
    b.blocked.provider_unreachable.should.equal(7);
    b.blocked.other.should.equal(0);
  });

  it('sums stuck and expired FILTER counts across groups', () => {
    const rows = [
      { form: 'A', state: 'RESPONDING', error_tag: 'none', fb_category: 'other', stuck: 2, expired: 0, count: 10 },
      { form: 'B', state: 'WAIT_EXTERNAL_EVENT', error_tag: 'none', fb_category: 'other', stuck: 1, expired: 3, count: 4 },
    ];
    const b = buildAggregates(rows, 24);
    b.stuck_users.should.equal(3);
    b.expired_waits.should.equal(3);
  });

  it('mirrors the same shape per form under by_form', () => {
    const rows = [
      { form: 'A', state: 'ERROR', error_tag: 'none', fb_category: 'other', stuck: 0, expired: 0, count: 1 },
      { form: 'B', state: 'BLOCKED', error_tag: 'none', fb_category: 'rate_limit', stuck: 0, expired: 0, count: 2 },
    ];
    const b = buildAggregates(rows, 24);
    b.by_form.A.error.study.should.equal(1);
    b.by_form.A.active_users.should.equal(1);
    b.by_form.B.blocked.rate_limit.should.equal(2);
    b.by_form.B.error.study.should.equal(0);
  });
});
