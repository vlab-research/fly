'use strict';

// Pure rule engine — evaluate(aggregates, rules) -> findings[].
//
// No IO, no Date, no config reads. Takes the aggregate bag (aggregate.js)
// and the declarative ruleset (rules.js) and returns resolved findings:
//
//   [{ id, level, message, count, ratio, active, action }]
//
// Message templating ({count}, {active}, {ratio} as a percent) is resolved
// here, server-side — the client renders strings verbatim and holds no
// health logic.
//
// Rules are implicitly grouped by `when.metric`: every rule is evaluated,
// but only the highest matching level per metric survives ('action' >
// 'note'), so e.g. error-spike supersedes error-trickle. Findings are
// sorted 'action' first.

const LEVEL_RANK = { action: 2, note: 1 };

// Dot-path lookup into the bag: 'blocked.template_missing' ->
// bag.blocked.template_missing. Returns undefined when the path is absent.
function metricValue(bag, path) {
  return path
    .split('.')
    .reduce((obj, key) => (obj == null ? undefined : obj[key]), bag);
}

function formatRatio(ratio) {
  const pct = ratio * 100;
  // One decimal, but drop it when it adds nothing ("5%", "0.1%").
  const rounded = Math.round(pct * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}%`;
}

function renderMessage(template, { count, active, ratio }) {
  return template
    .replace(/\{count\}/g, String(count))
    .replace(/\{active\}/g, String(active))
    .replace(/\{ratio\}/g, formatRatio(ratio));
}

function evaluate(aggregates, rules, warn = console.warn) {
  const active = aggregates.active_users || 0;
  const denominator = Math.max(active, 1);

  // Best (highest-level) matching rule per metric.
  const byMetric = {};

  rules.forEach(rule => {
    const { metric, count_gte: countGte, ratio_gte: ratioGte } = rule.when;
    const count = metricValue(aggregates, metric);

    if (typeof count !== 'number') {
      // Fail loud in logs, soft in product: a bad metric name in the
      // ruleset should never blank the researcher's dashboard.
      warn(`health rules: unknown metric '${metric}' in rule '${rule.id}'`);
      return;
    }

    const ratio = count / denominator;
    const matches =
      (countGte === undefined || count >= countGte) &&
      (ratioGte === undefined || ratio >= ratioGte);
    if (!matches) return;

    const current = byMetric[metric];
    if (current && LEVEL_RANK[current.level] >= LEVEL_RANK[rule.level]) return;

    byMetric[metric] = {
      id: rule.id,
      level: rule.level,
      message: renderMessage(rule.message, { count, active, ratio }),
      count,
      ratio,
      active,
      action: rule.action,
    };
  });

  return Object.values(byMetric).sort(
    (a, b) => LEVEL_RANK[b.level] - LEVEL_RANK[a.level]
  );
}

module.exports = { evaluate };
