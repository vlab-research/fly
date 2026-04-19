import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Layout, Table, Select, Row, Col, Tag, message, Card, Tooltip,
  Input, Button, Form, Alert, Popconfirm, Space, Typography,
} from 'antd';
import { CheckCircleTwoTone, CloseCircleTwoTone, LoadingOutlined, MinusCircleOutlined, PlusOutlined } from '@ant-design/icons';
import api from '../../services/api';
import { Loading } from '../../components/UI';
import LOCALES from './locales';

const { Content } = Layout;
const { Option } = Select;
const { TextArea } = Input;
const { Text, Paragraph } = Typography;

const NAME_PATTERN = /^[a-z0-9_]+$/;
const MAX_BODY_LENGTH = 1024;
const POLL_INTERVAL_MS = 4000;
const MAX_BUTTONS = 3;
const BUTTON_LABEL_MAX = 20;

const MessageTemplates = () => {
  const [pages, setPages] = useState([]);
  const [selectedPage, setSelectedPage] = useState(undefined);
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm();

  const pollRef = useRef(null);
  const selectedPageRef = useRef(selectedPage);
  useEffect(() => { selectedPageRef.current = selectedPage; }, [selectedPage]);

  const loadPages = async () => {
    const res = await api.fetcher({ path: '/media/pages' });
    return res.json();
  };

  const loadTemplates = useCallback(async (pageId) => {
    if (!pageId) return [];
    const res = await api.fetcher({ path: `/message-templates?pageId=${encodeURIComponent(pageId)}` });
    return res.json();
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const pagesData = await loadPages();
        setPages(pagesData);
      } catch (err) {
        message.error('Failed to load pages');
        console.error(err);
      } finally {
        setLoading(false);
      }
    })();
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
      if (!selectedPageRef.current) return;
      try {
        const data = await loadTemplates(selectedPageRef.current);
        if (cancelled) return;
        setTemplates(data);
        const anyPending = Array.isArray(data) && data.some(r => r.status === 'PENDING');
        if (!anyPending) clearPoll();
      } catch (err) {
        console.error(err);
        clearPoll();
      }
    };

    clearPoll();
    if (selectedPage) {
      refresh();
      pollRef.current = setInterval(refresh, POLL_INTERVAL_MS);
    } else {
      setTemplates([]);
    }

    return () => {
      cancelled = true;
      clearPoll();
    };
  }, [selectedPage, loadTemplates]);

  const onSubmit = async (values) => {
    if (!selectedPage) {
      message.error('Please select a page first');
      return;
    }
    setSubmitting(true);
    try {
      const res = await api.fetcher({
        path: '/message-templates',
        method: 'POST',
        body: {
          pageId: selectedPage,
          name: values.name,
          language: values.language,
          body: values.body,
          buttons: (values.buttons || []).filter(b => b && b.label && b.label.trim())
                                          .map(b => ({ label: b.label.trim() })),
        },
      });
      const record = await res.json();
      setTemplates(prev => [...prev, record].sort((a, b) => {
        const byName = a.name.localeCompare(b.name);
        return byName !== 0 ? byName : a.language.localeCompare(b.language);
      }));
      form.resetFields(['name', 'body', 'buttons']);
      message.success('Template submitted to Facebook for approval');

      if (!pollRef.current) {
        pollRef.current = setInterval(async () => {
          if (!selectedPageRef.current) return;
          try {
            const data = await loadTemplates(selectedPageRef.current);
            setTemplates(data);
            if (!data.some(r => r.status === 'PENDING')) {
              clearInterval(pollRef.current);
              pollRef.current = null;
            }
          } catch (e) {
            console.error(e);
          }
        }, POLL_INTERVAL_MS);
      }
    } catch (err) {
      let errorMsg = 'Unknown error';
      try {
        const parsed = JSON.parse(err.message);
        errorMsg = (parsed.error && parsed.error.message) || parsed.error || err.message;
      } catch (_) {
        errorMsg = err.message || errorMsg;
      }
      message.error('Create failed: ' + errorMsg);
    } finally {
      setSubmitting(false);
    }
  };

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

  const columns = [
    { title: 'Name', dataIndex: 'name', key: 'name', render: v => <Text code>{v}</Text> },
    {
      title: 'Language',
      dataIndex: 'language',
      key: 'language',
      render: code => {
        const hit = LOCALES.find(l => l.code === code);
        return hit ? `${hit.name} (${code})` : code;
      },
    },
    {
      title: 'Buttons',
      dataIndex: 'buttons',
      key: 'buttons',
      render: btns => {
        if (!Array.isArray(btns) || btns.length === 0) return <Text type="secondary">—</Text>;
        return btns.map(b => b.label).join(' · ');
      },
    },
    { title: 'Status', dataIndex: 'status', key: 'status', render: statusCell },
    {
      title: 'Created',
      dataIndex: 'created',
      key: 'created',
      render: d => new Date(d).toLocaleDateString(),
    },
    {
      title: '',
      key: 'actions',
      width: 80,
      render: (_, row) => (
        <Popconfirm
          title="Delete this template?"
          okText="Delete"
          okButtonProps={{ danger: true }}
          onConfirm={() => onDelete(row.id)}
        >
          <Button danger size="small" type="link">Delete</Button>
        </Popconfirm>
      ),
    },
  ];

  if (loading) return <Loading>Loading message templates...</Loading>;

  return (
    <Layout>
      <Content style={{ padding: '30px' }}>
        <h2>Message Templates</h2>
        <Paragraph type="secondary">
          Pre-approved Facebook Utility Message templates for sending non-promotional
          notifications (results, prizes, reminders) outside the 24-hour window. A template
          is identified by the combination of <Text code>name</Text> and <Text code>language</Text> —
          the same name may be created once per language, each approved independently.
        </Paragraph>

        {pages.length === 0 ? (
          <Alert
            message="No Facebook pages connected"
            description={(
              <span>
                Please <a href="/connect/facebook-messenger">connect a Facebook page</a> before creating templates.
              </span>
            )}
            type="warning"
            showIcon
            style={{ marginBottom: 24 }}
          />
        ) : (
          <Card title="Create Template" style={{ marginBottom: 24 }}>
            <Row gutter={16} style={{ marginBottom: 16 }}>
              <Col span={12}>
                <Select
                  showSearch
                  placeholder="Select page"
                  value={selectedPage}
                  onChange={setSelectedPage}
                  style={{ width: '100%' }}
                  optionFilterProp="children"
                >
                  {pages.map(p => (
                    <Option key={p.id} value={p.id}>{p.name}</Option>
                  ))}
                </Select>
              </Col>
            </Row>

            <Form
              form={form}
              layout="vertical"
              onFinish={onSubmit}
              initialValues={{ language: 'en_US' }}
              disabled={!selectedPage || submitting}
            >
              <Form.Item
                label="Template name"
                name="name"
                extra="Lowercase letters, digits, and underscores only (snake_case). Must be unique per (page, language)."
                rules={[
                  { required: true, message: 'Name is required' },
                  { pattern: NAME_PATTERN, message: 'Use snake_case: lowercase letters, digits, underscores' },
                ]}
              >
                <Input placeholder="e.g. prize_notification" maxLength={512} />
              </Form.Item>

              <Form.Item
                label="Language"
                name="language"
                rules={[{ required: true, message: 'Language is required' }]}
              >
                <Select
                  showSearch
                  optionFilterProp="children"
                  placeholder="Select language"
                  filterOption={(input, option) => (
                    (option.children || '').toString().toLowerCase().includes(input.toLowerCase())
                  )}
                >
                  {LOCALES.map(l => (
                    <Option key={l.code} value={l.code}>{l.name} ({l.code})</Option>
                  ))}
                </Select>
              </Form.Item>

              <Form.Item
                label="Body"
                name="body"
                extra={(
                  <span>
                    Use <Text code>{'{{1}}'}</Text>, <Text code>{'{{2}}'}</Text>, etc. for dynamic values.
                    In your survey, pass values via <Text code>params: [...]</Text> in the same order.
                    Max {MAX_BODY_LENGTH} characters.
                  </span>
                )}
                rules={[
                  { required: true, message: 'Body is required' },
                  { max: MAX_BODY_LENGTH, message: `Body must be at most ${MAX_BODY_LENGTH} characters` },
                ]}
              >
                <TextArea
                  rows={4}
                  maxLength={MAX_BODY_LENGTH}
                  showCount
                  placeholder="Your {{1}} results are ready, {{2}}."
                />
              </Form.Item>

              <Form.Item
                label="Quick-reply buttons (optional)"
                extra={(
                  <span>
                    Let users tap instead of typing. Up to {MAX_BUTTONS} buttons, label max {BUTTON_LABEL_MAX} chars.
                    Labels are <b>locked after Facebook approves the template</b> — to change them, delete and recreate.
                    In your survey JSON, pass <Text code>buttons: ["value1", "value2", ...]</Text> in the same order.
                  </span>
                )}
              >
                <Form.List name="buttons">
                  {(fields, { add, remove }) => (
                    <>
                      {fields.map((field, i) => (
                        <Space key={field.key} align="baseline" style={{ display: 'flex', marginBottom: 8 }}>
                          <Form.Item
                            {...field}
                            name={[field.name, 'label']}
                            fieldKey={[field.fieldKey, 'label']}
                            style={{ marginBottom: 0, width: 320 }}
                            rules={[
                              { required: true, message: 'Label required' },
                              { max: BUTTON_LABEL_MAX, message: `Max ${BUTTON_LABEL_MAX} chars` },
                              ({ getFieldValue }) => ({
                                validator(_, value) {
                                  if (!value) return Promise.resolve();
                                  const all = (getFieldValue('buttons') || []).map(b => b && b.label && b.label.trim());
                                  const trimmed = value.trim();
                                  const count = all.filter(l => l === trimmed).length;
                                  return count > 1
                                    ? Promise.reject(new Error('Duplicate label'))
                                    : Promise.resolve();
                                },
                              }),
                            ]}
                          >
                            <Input
                              placeholder={`Button ${i + 1} label`}
                              maxLength={BUTTON_LABEL_MAX}
                              showCount
                            />
                          </Form.Item>
                          <MinusCircleOutlined onClick={() => remove(field.name)} />
                        </Space>
                      ))}
                      <Form.Item style={{ marginBottom: 0 }}>
                        <Button
                          type="dashed"
                          onClick={() => add({ label: '' })}
                          icon={<PlusOutlined />}
                          disabled={fields.length >= MAX_BUTTONS}
                        >
                          Add button {fields.length > 0 ? `(${fields.length}/${MAX_BUTTONS})` : ''}
                        </Button>
                      </Form.Item>
                    </>
                  )}
                </Form.List>
              </Form.Item>

              <Form.Item>
                <Space>
                  <Button type="primary" htmlType="submit" loading={submitting} disabled={!selectedPage}>
                    Submit for approval
                  </Button>
                  <Text type="secondary">
                    Facebook does not allow editing utility templates. To change wording, delete and recreate.
                  </Text>
                </Space>
              </Form.Item>
            </Form>
          </Card>
        )}

        <Card title="Templates">
          <Table
            dataSource={templates}
            rowKey="id"
            columns={columns}
            pagination={{ pageSize: 20 }}
            locale={{ emptyText: selectedPage ? 'No templates yet' : 'Select a page to view templates' }}
          />
        </Card>
      </Content>
    </Layout>
  );
};

export default MessageTemplates;
