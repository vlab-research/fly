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
import fetchMessagingAccounts from './accounts';

const { Content } = Layout;
const { Text } = Typography;

const POLL_INTERVAL_MS = 4000;

function renderName(v) { return <Text code>{v}</Text>; }
function renderButtons(btns) {
  if (!Array.isArray(btns) || btns.length === 0) return <Text type="secondary">—</Text>;
  return btns.map(b => b.label).join(' · ');
}

const cmp = (a, b) => String(a || '').localeCompare(String(b || ''));

// Name is the axis that matters: one template name is registered once per
// messaging account, with independent statuses. Sorting by name puts every
// account's registration of a name together so their statuses read side by
// side. Ties fall through to language then account so the grouping is stable.
const byName = (a, b) => cmp(a.name, b.name)
  || cmp(a.language, b.language)
  || cmp(a.account_id, b.account_id);

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
        const [data, accountsData] = await Promise.all([
          loadTemplates(),
          fetchMessagingAccounts(),
        ]);
        if (cancelled) return;
        setTemplates(data);
        setPageMap(accountsData.reduce((acc, p) => ({ ...acc, [p.id]: p.name }), {}));
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
      <Tooltip title="Create the same template on another messaging account">
        <Button
          size="small"
          type="link"
          onClick={() => history.push(`/message-templates/new?duplicate=${row.id}`)}
        >
          Duplicate
        </Button>
      </Tooltip>
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

  const accountLabel = id => pageMap[id] || id;

  const columns = [
    {
      title: 'Name',
      dataIndex: 'name',
      key: 'name',
      render: renderName,
      sorter: byName,
      defaultSortOrder: 'ascend',
    },
    {
      title: 'Language',
      dataIndex: 'language',
      key: 'language',
      render: renderLanguage,
      sorter: (a, b) => cmp(a.language, b.language) || byName(a, b),
    },
    {
      title: 'Account',
      dataIndex: 'account_id',
      key: 'page',
      render: accountLabel,
      sorter: (a, b) => cmp(accountLabel(a.account_id), accountLabel(b.account_id)) || byName(a, b),
    },
    {
      title: 'Buttons', dataIndex: 'buttons', key: 'buttons', render: renderButtons,
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      render: statusCell,
      sorter: (a, b) => cmp(a.status, b.status) || byName(a, b),
    },
    {
      title: 'Created',
      dataIndex: 'created',
      key: 'created',
      render: d => new Date(d).toLocaleDateString(),
      sorter: (a, b) => new Date(a.created) - new Date(b.created),
    },
    {
      title: '', key: 'actions', width: 200, render: renderActions,
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
          <Text type="secondary" style={{ display: 'block', marginBottom: 12 }}>
            Sorted by name, so every account&apos;s registration of a template sits
            together and their statuses can be compared. A survey that runs on both
            Messenger and WhatsApp needs the same name approved on each account.
          </Text>
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
