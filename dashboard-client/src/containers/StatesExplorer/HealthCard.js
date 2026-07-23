import React from 'react';
import PropTypes from 'prop-types';
import { Link, useRouteMatch } from 'react-router-dom';
import { Card, Button, Typography } from 'antd';
import {
  CheckCircleFilled,
  ExclamationCircleFilled,
} from '@ant-design/icons';
import { destToUrl } from './healthNav';

const { Text } = Typography;

const AMBER = '#faad14';
const GREEN = '#52c41a';

// A finding's action rendered as a link/button, or nothing when the dest is
// unknown (forward-compat: server may grow new dests before the client).
const ActionLink = ({ action, monitorUrl, type }) => {
  const url = destToUrl(action, monitorUrl);
  if (!url) return null;
  return (
    <Link to={url}>
      <Button size="small" type={type}>{action.label}</Button>
    </Link>
  );
};

// Health card on Monitor -> Summary — always present once loaded. Healthy
// renders an explicit "no issues" line (trust in silence must be earned);
// otherwise `action` findings render prominently and `note` findings as
// muted secondary lines. All copy arrives resolved from the server.
const HealthCard = ({ findings, windowHours }) => {
  const match = useRouteMatch();

  if (findings === null) return null; // not loaded yet — avoid flashing "✓"

  const actions = findings.filter(f => f.level === 'action');
  const notes = findings.filter(f => f.level === 'note');

  if (findings.length === 0) {
    return (
      <Card size="small" style={{ marginBottom: 24 }}>
        <Text type="secondary">
          <CheckCircleFilled style={{ color: GREEN, marginRight: 8 }} />
          {`No issues in the last ${windowHours}h`}
        </Text>
      </Card>
    );
  }

  return (
    <Card size="small" title="Health" style={{ marginBottom: 24 }}>
      {actions.map(finding => (
        <div key={finding.id} style={{ display: 'flex', alignItems: 'baseline', marginBottom: 12 }}>
          <ExclamationCircleFilled style={{ color: AMBER, marginRight: 8 }} />
          <span style={{ flex: 1, marginRight: 12 }}>{finding.message}</span>
          <ActionLink action={finding.action} monitorUrl={match.url} type="default" />
        </div>
      ))}
      {notes.map(finding => (
        <div key={finding.id} style={{ marginBottom: 4 }}>
          <Text type="secondary" style={{ marginRight: 12 }}>{finding.message}</Text>
          <ActionLink action={finding.action} monitorUrl={match.url} type="link" />
        </div>
      ))}
    </Card>
  );
};

ActionLink.propTypes = {
  action: PropTypes.object,
  monitorUrl: PropTypes.string.isRequired,
  type: PropTypes.string.isRequired,
};

HealthCard.propTypes = {
  findings: PropTypes.arrayOf(PropTypes.object),
  windowHours: PropTypes.number,
};

HealthCard.defaultProps = {
  findings: null,
  windowHours: 24,
};

export default HealthCard;
