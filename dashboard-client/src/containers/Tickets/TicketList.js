import React, { useMemo, useState } from 'react';
import PropTypes from 'prop-types';
import {
  Badge, Button, Empty, Space, Tabs, Tag, Tooltip, Typography,
} from 'antd';
import { PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { Link } from 'react-router-dom';
import {
  dotProps, isClosed, tagColor, timeAgo,
} from './stateMeta';

const { Text } = Typography;

const ticketShape = PropTypes.shape({
  id: PropTypes.string.isRequired,
  identifier: PropTypes.string,
  title: PropTypes.string,
  state: PropTypes.string,
  updatedAt: PropTypes.string,
});

function byRecentActivity(a, b) {
  return new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0);
}

function TicketItem({ ticket, selected }) {
  const closed = isClosed(ticket.state);
  const className = [
    'ticket-item',
    selected ? 'selected' : '',
    closed ? 'closed' : '',
  ].join(' ').trim();

  return (
    <Link to={`/tickets/${encodeURIComponent(ticket.id)}`} className={className}>
      <div className="ticket-item-top">
        <Badge {...dotProps(ticket.state)} />
        <span className="ticket-item-title" title={ticket.title}>
          {ticket.title}
        </span>
      </div>
      <div className="ticket-item-bottom">
        <Text code>{ticket.identifier}</Text>
        <Tag color={tagColor(ticket.state)}>{ticket.state || '—'}</Tag>
        <Tooltip title={ticket.updatedAt ? new Date(ticket.updatedAt).toLocaleString() : ''}>
          <Text type="secondary" className="ticket-item-time">
            {timeAgo(ticket.updatedAt)}
          </Text>
        </Tooltip>
      </div>
    </Link>
  );
}

TicketItem.propTypes = {
  ticket: ticketShape.isRequired,
  selected: PropTypes.bool,
};

const TicketList = ({
  tickets, selectedId, onRefresh, refreshing,
}) => {
  const [tab, setTab] = useState('open');

  const { open, closed } = useMemo(() => ({
    open: tickets.filter(t => !isClosed(t.state)).sort(byRecentActivity),
    closed: tickets.filter(t => isClosed(t.state)).sort(byRecentActivity),
  }), [tickets]);

  const shown = tab === 'open' ? open : closed;

  const tabLabel = (label, list) => `${label} (${list.length})`;

  return (
    <div>
      <div className="ticket-list-header">
        <h3>Support</h3>
        <Space size={4}>
          <Tooltip title="Refresh">
            <Button
              type="text"
              size="small"
              icon={<ReloadOutlined spin={refreshing} />}
              onClick={onRefresh}
              aria-label="Refresh tickets"
            />
          </Tooltip>
          <Link to="/tickets/new">
            <Button type="primary" size="small" icon={<PlusOutlined />}>
              New Ticket
            </Button>
          </Link>
        </Space>
      </div>

      <Tabs
        className="ticket-list-tabs"
        activeKey={tab}
        onChange={setTab}
        size="small"
      >
        <Tabs.TabPane tab={tabLabel('Open', open)} key="open" />
        <Tabs.TabPane tab={tabLabel('Closed', closed)} key="closed" />
      </Tabs>

      <div className="ticket-list-items">
        {shown.length === 0 ? (
          <Empty
            className="ticket-list-empty"
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={tab === 'open' ? 'No open tickets' : 'No closed tickets'}
          />
        ) : (
          shown.map(t => (
            <TicketItem key={t.id} ticket={t} selected={t.id === selectedId} />
          ))
        )}
      </div>
    </div>
  );
};

TicketList.propTypes = {
  tickets: PropTypes.arrayOf(ticketShape).isRequired,
  selectedId: PropTypes.string,
  onRefresh: PropTypes.func.isRequired,
  refreshing: PropTypes.bool,
};

export default TicketList;
