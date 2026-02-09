import React, { useState, useEffect } from 'react';
import { Link, useHistory } from 'react-router-dom';
import { Table, Layout, Switch, Tag, Space, Button, Popconfirm, message } from 'antd';
import { PlusOutlined, EditOutlined, DeleteOutlined, HistoryOutlined } from '@ant-design/icons';
import api from '../../services/api';
import { Loading, CreateBtn } from '../../components/UI';
import './BailSystems.css';

const { Content } = Layout;

const BailSystems = () => {
  const history = useHistory();
  const [bails, setBails] = useState(null);
  const [loading, setLoading] = useState(true);
  const [userId, setUserId] = useState(null);

  useEffect(() => {
    loadUser();
  }, []);

  const loadUser = async () => {
    try {
      const res = await api.fetcher({ path: '/users', method: 'POST', body: {} });
      const user = await res.json();
      setUserId(user.id);
      await loadBails(user.id);
    } catch (err) {
      message.error('Failed to load user');
      console.error(err);
      setLoading(false);
    }
  };

  const loadBails = async (uid) => {
    try {
      const res = await api.fetcher({ path: `/users/${uid}/bails` });
      const data = await res.json();
      setBails(data.bails || []);
    } catch (err) {
      message.error('Failed to load bail systems');
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const handleToggleEnabled = async (bail, enabled) => {
    try {
      await api.fetcher({
        path: `/users/${userId}/bails/${bail.bail.id}`,
        method: 'PUT',
        body: { enabled },
      });
      setBails(bails.map(b =>
        b.bail.id === bail.bail.id
          ? { ...b, bail: { ...b.bail, enabled } }
          : b
      ));
      message.success(`Bail ${enabled ? 'enabled' : 'disabled'}`);
    } catch (err) {
      message.error('Failed to update bail');
    }
  };

  const handleDelete = async (bailId) => {
    try {
      await api.fetcher({
        path: `/users/${userId}/bails/${bailId}`,
        method: 'DELETE',
        raw: true,
      });
      setBails(bails.filter(b => b.bail.id !== bailId));
      message.success('Bail deleted');
    } catch (err) {
      message.error('Failed to delete bail');
    }
  };

  const columns = [
    {
      title: 'Name',
      dataIndex: ['bail', 'name'],
      key: 'name',
      render: (text, record) => (
        <Link to={`/bails/${record.bail.id}/edit`}>
          {text}
        </Link>
      ),
    },
    {
      title: 'Enabled',
      dataIndex: ['bail', 'enabled'],
      key: 'enabled',
      render: (enabled, record) => (
        <Switch
          checked={enabled}
          onChange={(checked) => handleToggleEnabled(record, checked)}
        />
      ),
    },
    {
      title: 'Timing',
      dataIndex: ['bail', 'definition', 'execution', 'timing'],
      key: 'timing',
      render: (timing) => {
        const colors = {
          immediate: 'green',
          scheduled: 'blue',
          absolute: 'orange',
        };
        return (
          <Tag color={colors[timing] || 'default'}>
            {timing || 'immediate'}
          </Tag>
        );
      },
    },
    {
      title: 'Destination',
      dataIndex: ['bail', 'definition', 'action', 'destination_form'],
      key: 'destination',
    },
    {
      title: 'Last Execution',
      dataIndex: 'last_event',
      key: 'last_event',
      render: (event) => {
        if (!event) return <span style={{ color: '#999' }}>Never</span>;
        return (
          <span>
            {new Date(event.timestamp).toLocaleString()}
            <br />
            <small>
              {event.users_matched} matched, {event.users_bailed} bailed
            </small>
          </span>
        );
      },
    },
    {
      title: 'Actions',
      key: 'actions',
      render: (_, record) => (
        <Space>
          <Button
            icon={<EditOutlined />}
            size="small"
            onClick={() => history.push(`/bails/${record.bail.id}/edit`)}
          />
          <Button
            icon={<HistoryOutlined />}
            size="small"
            onClick={() => history.push(`/bails/${record.bail.id}/events`)}
          />
          <Popconfirm
            title="Delete this bail system?"
            onConfirm={() => handleDelete(record.bail.id)}
            okText="Yes"
            cancelText="No"
          >
            <Button icon={<DeleteOutlined />} size="small" danger />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  if (loading) return <Loading>Loading bail systems...</Loading>;

  return (
    <Layout>
      <Content style={{ padding: '30px' }}>
        <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between' }}>
          <h2>Bail Systems</h2>
          <CreateBtn to="/bails/create">
            <PlusOutlined /> New Bail System
          </CreateBtn>
        </div>
        <Table
          columns={columns}
          dataSource={bails}
          rowKey={(record) => record.bail.id}
          pagination={{ pageSize: 20 }}
        />
      </Content>
    </Layout>
  );
};

export default BailSystems;
