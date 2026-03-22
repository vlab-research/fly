import React, { useState, useEffect } from 'react';
import { useParams, useHistory } from 'react-router-dom';
import { Layout, Card, Descriptions, Tag, Table, Typography, Button, message, Alert } from 'antd';
import { ArrowLeftOutlined } from '@ant-design/icons';
import api from '../../services/api';
import { Loading } from '../../components/UI';

const { Content } = Layout;
const { Text } = Typography;

const BailEventDetail = () => {
  const { bailId, eventId } = useParams();
  const history = useHistory();
  const [event, setEvent] = useState(null);
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
      const eventsRes = await api.fetcher({ path: `/users/${userId}/bails/${bailId}/events` });
      const eventsData = await eventsRes.json();
      const found = (eventsData.events || []).find(e => e.id === eventId);
      if (!found) {
        message.error('Event not found');
      }
      setEvent(found || null);
    } catch (err) {
      message.error('Failed to load event');
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  if (loading) return <Loading>Loading event...</Loading>;

  if (!event) {
    return (
      <Layout>
        <Content style={{ padding: '30px' }}>
          <Button icon={<ArrowLeftOutlined />} onClick={() => history.push(`/bails/${bailId}/events`)} style={{ marginBottom: 16 }}>
            Back to Events
          </Button>
          <Alert type="error" message="Event not found" />
        </Content>
      </Layout>
    );
  }

  const bailedUserIDs = event.execution_results && event.execution_results.user_ids
    ? event.execution_results.user_ids
    : [];

  const userColumns = [
    {
      title: '#',
      key: 'index',
      render: (_, __, index) => index + 1,
      width: 60,
    },
    {
      title: 'User ID',
      dataIndex: 'id',
      key: 'id',
      render: (id) => <Text code copyable>{id}</Text>,
    },
  ];

  const userRows = bailedUserIDs.map(id => ({ id, key: id }));

  return (
    <Layout>
      <Content style={{ padding: '30px' }}>
        <Button
          icon={<ArrowLeftOutlined />}
          onClick={() => history.push(`/bails/${bailId}/events`)}
          style={{ marginBottom: 16 }}
        >
          Back to Events
        </Button>

        <Card title="Event Details" style={{ marginBottom: 24 }}>
          <Descriptions bordered column={2}>
            <Descriptions.Item label="Event ID" span={2}>
              <Text code>{event.id}</Text>
            </Descriptions.Item>
            <Descriptions.Item label="Timestamp">
              {new Date(event.timestamp).toLocaleString()}
            </Descriptions.Item>
            <Descriptions.Item label="Event Type">
              <Tag color={event.event_type === 'execution' ? 'green' : 'red'}>
                {event.event_type}
              </Tag>
            </Descriptions.Item>
            <Descriptions.Item label="Users Matched">
              {event.users_matched}
            </Descriptions.Item>
            <Descriptions.Item label="Users Bailed">
              {event.users_bailed}
            </Descriptions.Item>
            {event.error && (
              <Descriptions.Item label="Error" span={2}>
                <Text type="danger">{event.error.message || JSON.stringify(event.error)}</Text>
              </Descriptions.Item>
            )}
          </Descriptions>
        </Card>

        {event.event_type === 'execution' && (
          <Card title={`Bailed User IDs (${bailedUserIDs.length})`}>
            {bailedUserIDs.length === 0 ? (
              <Text type="secondary">No users were bailed in this execution.</Text>
            ) : (
              <Table
                columns={userColumns}
                dataSource={userRows}
                rowKey="id"
                pagination={{ pageSize: 100 }}
                size="small"
              />
            )}
          </Card>
        )}
      </Content>
    </Layout>
  );
};

export default BailEventDetail;
