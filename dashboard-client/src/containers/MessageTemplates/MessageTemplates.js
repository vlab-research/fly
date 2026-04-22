import React, {
  useState, useEffect, useRef, useCallback,
} from 'react';
import {
  Layout, Table, Tag, message, Card, Tooltip,
  Button, Popconfirm, Space, Typography,
} from 'antd';
import { CheckCircleTwoTone, CloseCircleTwoTone, LoadingOutlined } from '@ant-design/icons';
import { useHistory } from 'react-router-dom';
import api from '../../services/api';
import { Loading } from '../../components/UI';
import LOCALES from './locales';

const { Content } = Layout;
const { Text } = Typography;

const POLL_INTERVAL_MS = 4000;

function renderName(v) { return <Text code>{v}</Text>; }
function renderButtons(btns) {
  if (!Array.isArray(btns) || btns.length === 0) return <Text type="secondary">—</Text>;
  return btns.map(b => b.label).join(' · ');
}

const MessageTemplates = () => {
  const history = useHistory();
  const [templates, setTemplates] = useState([]);
  const [pageMap, setPageMap] = useState({});
  const [loading, setLoading] = useState(true);
  const pollRef = useRef(null);

  const loadTemplates = useCallback(async () => {
    const res = await api.fetcher({ path: '/message-templates' });
    return res.json();
  }, []);

  useEffect(() => {
    let cancelled = false;
    const clearPoll = () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };

    const refresh = async () => {
      try {
        const data = await loadTemplates();
        if (cancelled) return;
        setTemplates(data);
        if (!Array.isArray(data) || !data.some(r => r.status === 'PENDING')) clearPoll();
      } catch (err) {
        console.error(err);
        clearPoll();
      }
    };

    (async () => {
      try {
        const [data, pagesData] = await Promise.all([
          loadTemplates(),
          api.fetcher({ path: '/media/pages' }).then(r => r.json()),
        ]);
        if (cancelled) return;
        setTemplates(data);
        setPageMap(pagesData.reduce((acc, p) => ({ ...acc, [p.id]: p.name }), {}));
        if (Array.isArray(data) && data.some(r => r.status === 'PENDING')) {
          pollRef.current = setInterval(refresh, POLL_INTERVAL_MS);
        }
      } catch (err) {
        message.error('Failed to load templates');
        console.error(err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      clearPoll();
    };
  }, [loadTemplates]);

  const onDelete = async (id) => {
    try {
      await api.fetcher({ path: `/message-templates/${id}`, method: 'DELETE' });
      setTemplates(prev => prev.filter(r => r.id !== id));
      message.success('Template deleted');
    } catch (err) {
      message.error('Delete failed');
      console.error(err);
    }
  };

  const statusCell = (status, row) => {
    if (status === 'PENDING') {
      return <Tag icon={<LoadingOutlined />} color="processing">Pending</Tag>;
    }
    if (status === 'APPROVED') {
      return <Tag icon={<CheckCircleTwoTone twoToneColor="#52c41a" />} color="success">Approved</Tag>;
    }
    if (status === 'REJECTED') {
      const tag = <Tag icon={<CloseCircleTwoTone twoToneColor="#f5222d" />} color="error">Rejected</Tag>;
      if (row.rejection_reason) {
        return <Tooltip title={row.rejection_reason}>{tag}</Tooltip>;
      }
      return tag;
    }
    return <Tag>{status}</Tag>;
  };

  const renderLanguage = (code) => {
    const hit = LOCALES.find(l => l.code === code);
    return hit ? `${hit.name} (${code})` : code;
  };

  const renderActions = (_, row) => (
    <Space>
      <Button
        size="small"
        type="link"
        onClick={() => history.push(`/message-templates/${row.id}`)}
      >
        View
      </Button>
      <Popconfirm
        title="Delete this template?"
        okText="Delete"
        okButtonProps={{ danger: true }}
        onConfirm={() => onDelete(row.id)}
      >
        <Button danger size="small" type="link">Delete</Button>
      </Popconfirm>
    </Space>
  );

  const columns = [
    {
      title: 'Name', dataIndex: 'name', key: 'name', render: renderName,
    },
    {
      title: 'Language', dataIndex: 'language', key: 'language', render: renderLanguage,
    },
    {
      title: 'Page', dataIndex: 'facebook_page_id', key: 'page', render: id => pageMap[id] || id,
    },
    {
      title: 'Buttons', dataIndex: 'buttons', key: 'buttons', render: renderButtons,
    },
    {
      title: 'Status', dataIndex: 'status', key: 'status', render: statusCell,
    },
    {
      title: 'Created', dataIndex: 'created', key: 'created', render: d => new Date(d).toLocaleDateString(),
    },
    {
      title: '', key: 'actions', width: 80, render: renderActions,
    },
  ];

  if (loading) return <Loading>Loading message templates...</Loading>;

  return (
    <Layout>
      <Content style={{ padding: '30px' }}>
        <h2>Message Templates</h2>
        <Card
          title="Templates"
          extra={(
            <Button type="primary" onClick={() => history.push('/message-templates/new')}>
              New Template
            </Button>
          )}
        >
          <Table
            dataSource={templates}
            rowKey="id"
            columns={columns}
            pagination={{ pageSize: 20 }}
            locale={{
              emptyText: (
                <span>
                  No templates yet.
                  {' '}
                  <Button type="link" style={{ padding: 0 }} onClick={() => history.push('/message-templates/new')}>
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

export default MessageTemplates;
