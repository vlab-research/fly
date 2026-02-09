import React, { useState, useEffect } from 'react';
import { useParams, useHistory } from 'react-router-dom';
import { Table, Layout, Tag, Button, Card, message } from 'antd';
import { ArrowLeftOutlined } from '@ant-design/icons';
import api from '../../services/api';
import { Loading } from '../../components/UI';

const { Content } = Layout;

const BailEvents = () => {
  const { bailId } = useParams();
  const history = useHistory();
  const [events, setEvents] = useState(null);
  const [bail, setBail] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadUser();
  }, []);

  const loadUser = async () => {
    try {
      const res = await api.fetcher({ path: '/users', method: 'POST', body: {} });
      const user = await res.json();
      await loadData(user.id);
    } catch (err) {
      message.error('Failed to load user');
      console.error(err);
      setLoading(false);
    }
  };

  const loadData = async (userId) => {
    try {
      const [eventsRes, bailRes] = await Promise.all([
        api.fetcher({ path: `/users/${userId}/bails/${bailId}/events` }),
        api.fetcher({ path: `/users/${userId}/bails/${bailId}` }),
      ]);

      const eventsData = await eventsRes.json();
      const bailData = await bailRes.json();

      setEvents(eventsData.events || []);
      setBail(bailData.bail);
    } catch (err) {
      message.error('Failed to load events');
      console.error('Failed to load events:', err);
    } finally {
      setLoading(false);
    }
  };

  const columns = [
    {
      title: 'Timestamp',
      dataIndex: 'timestamp',
      key: 'timestamp',
      render: (ts) => new Date(ts).toLocaleString(),
      sorter: (a, b) => new Date(b.timestamp) - new Date(a.timestamp),
      defaultSortOrder: 'descend',
    },
    {
      title: 'Event Type',
      dataIndex: 'event_type',
      key: 'event_type',
      render: (type) => (
        <Tag color={type === 'execution' ? 'green' : 'red'}>
          {type}
        </Tag>
      ),
    },
    {
      title: 'Users Matched',
      dataIndex: 'users_matched',
      key: 'users_matched',
    },
    {
      title: 'Users Bailed',
      dataIndex: 'users_bailed',
      key: 'users_bailed',
    },
    {
      title: 'Error',
      dataIndex: 'error',
      key: 'error',
      render: (error) => error ? (
        <span style={{ color: 'red' }}>{error.message || JSON.stringify(error)}</span>
      ) : '-',
    },
  ];

  if (loading) return <Loading>Loading events...</Loading>;

  return (
    <Layout>
      <Content style={{ padding: '30px' }}>
        <Button
          icon={<ArrowLeftOutlined />}
          onClick={() => history.push('/bails')}
          style={{ marginBottom: 16 }}
        >
          Back to Bail Systems
        </Button>

        <Card title={`Event History: ${(bail && bail.name) || 'Bail'}`}>
          <Table
            columns={columns}
            dataSource={events}
            rowKey="id"
            pagination={{ pageSize: 50 }}
          />
        </Card>
      </Content>
    </Layout>
  );
};

export default BailEvents;
