import React, { useState, useEffect, useCallback } from 'react';
import {
  Layout, Table, Tag, message, Card, Button, Typography,
} from 'antd';
import { useHistory } from 'react-router-dom';
import api from '../../services/api';
import { Loading } from '../../components/UI';

const { Content } = Layout;
const { Text } = Typography;

const STATE_COLORS = {
  Backlog: 'default',
  Triaged: 'blue',
  'In Progress': 'processing',
  'In Review': 'cyan',
  Done: 'success',
  Canceled: 'default',
};

function stateTag(state) {
  const color = STATE_COLORS[state] || 'default';
  return <Tag color={color}>{state || '—'}</Tag>;
}

function renderIdentifier(v) { return <Text code>{v || '—'}</Text>; }

const Tickets = () => {
  const history = useHistory();
  const [tickets, setTickets] = useState([]);
  const [loading, setLoading] = useState(true);

  const loadTickets = useCallback(async () => {
    const res = await api.fetcher({ path: '/tickets' });
    return res.json();
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await loadTickets();
        if (cancelled) return;
        setTickets(Array.isArray(data) ? data : []);
      } catch (err) {
        let msg = 'Failed to load tickets';
        try {
          msg = JSON.parse(err.message).error || msg;
        } catch (_) { msg = err.message || msg; }
        message.error(msg);
        console.error(err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [loadTickets]);

  const renderActions = (_, row) => (
    <Button
      size="small"
      type="link"
      onClick={() => history.push(`/tickets/${encodeURIComponent(row.id)}`)}
    >
      Open
    </Button>
  );

  const columns = [
    {
      title: 'ID',
      dataIndex: 'identifier',
      key: 'identifier',
      width: 110,
      render: renderIdentifier,
    },
    { title: 'Title', dataIndex: 'title', key: 'title' },
    {
      title: 'State', dataIndex: 'state', key: 'state', width: 140, render: stateTag,
    },
    {
      title: 'Created',
      dataIndex: 'createdAt',
      key: 'created',
      width: 160,
      render: d => (d ? new Date(d).toLocaleString() : '—'),
    },
    {
      title: '', key: 'actions', width: 80, render: renderActions,
    },
  ];

  if (loading) return <Loading>Loading tickets…</Loading>;

  return (
    <Layout>
      <Content style={{ padding: '30px' }}>
        <h2>Support Tickets</h2>
        <Card
          title="Your tickets"
          extra={(
            <Button type="primary" onClick={() => history.push('/tickets/new')}>
              New Ticket
            </Button>
          )}
        >
          <Table
            dataSource={tickets}
            rowKey="id"
            columns={columns}
            pagination={{ pageSize: 20 }}
            locale={{
              emptyText: (
                <span>
                  No tickets yet.
                  {' '}
                  <Button type="link" style={{ padding: 0 }} onClick={() => history.push('/tickets/new')}>
                    Create one
                  </Button>
                </span>
              ),
            }}
          />
        </Card>
      </Content>
    </Layout>
  );
};

export default Tickets;
