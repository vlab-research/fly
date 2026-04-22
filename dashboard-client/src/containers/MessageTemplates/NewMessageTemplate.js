import React, { useState, useEffect } from 'react';
import {
  Layout, Select, Row, Col, message, Card,
  Input, Button, Form, Alert, Space, Typography,
} from 'antd';
import { MinusCircleOutlined, PlusOutlined } from '@ant-design/icons';
import { useHistory } from 'react-router-dom';
import api from '../../services/api';
import { Loading } from '../../components/UI';
import LOCALES from './locales';

const { Content } = Layout;
const { Option } = Select;
const { TextArea } = Input;
const { Text } = Typography;

const NAME_PATTERN = /^[a-z0-9_]+$/;
const MAX_BODY_LENGTH = 1024;
const MAX_BUTTONS = 3;
const BUTTON_LABEL_MAX = 20;
const PLACEHOLDER_PATTERN = /\{\{(\d+)\}\}/g;

const extractPlaceholderIndices = (body) => {
  if (!body) return [];
  const indices = new Set();
  PLACEHOLDER_PATTERN.lastIndex = 0;
  let match = PLACEHOLDER_PATTERN.exec(body);
  while (match !== null) {
    indices.add(Number(match[1]));
    match = PLACEHOLDER_PATTERN.exec(body);
  }
  return Array.from(indices).sort((a, b) => a - b);
};

const NewMessageTemplate = () => {
  const history = useHistory();
  const [pages, setPages] = useState([]);
  const [selectedPage, setSelectedPage] = useState(undefined);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [placeholderIndices, setPlaceholderIndices] = useState([]);
  const [form] = Form.useForm();

  useEffect(() => {
    (async () => {
      try {
        const res = await api.fetcher({ path: '/media/pages' });
        const data = await res.json();
        setPages(data);
        if (data.length === 1) setSelectedPage(data[0].id);
      } catch (err) {
        message.error('Failed to load pages');
        console.error(err);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const onSubmit = async (values) => {
    if (!selectedPage) {
      message.error('Please select a page first');
      return;
    }
    setSubmitting(true);
    try {
      const indices = extractPlaceholderIndices(values.body);
      const examples = indices.map((_, i) => {
        const v = values.examples && values.examples[i];
        return typeof v === 'string' ? v.trim() : '';
      });
      await api.fetcher({
        path: '/message-templates',
        method: 'POST',
        body: {
          pageId: selectedPage,
          name: values.name,
          language: values.language,
          body: values.body,
          buttons: (values.buttons || []).filter(b => b && b.label && b.label.trim())
            .map(b => ({ label: b.label.trim() })),
          examples,
        },
      });
      message.success('Template submitted to Facebook for approval');
      history.push('/message-templates');
    } catch (err) {
      let errorMsg = 'Unknown error';
      try {
        const parsed = JSON.parse(err.message);
        errorMsg = (parsed.error && parsed.error.message) || parsed.error || err.message;
      } catch (_) {
        errorMsg = err.message || errorMsg;
      }
      message.error(`Create failed: ${errorMsg}`);
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) return <Loading>Loading pages...</Loading>;

  return (
    <Layout>
      <Content style={{ padding: '30px' }}>
        <h2>New Message Template</h2>

        {pages.length === 0 ? (
          <Alert
            message="No Facebook pages connected"
            description={(
              <span>
                Please
                {' '}
                <a href="/connect/facebook-messenger">connect a Facebook page</a>
                {' '}
before creating templates.
              </span>
            )}
            type="warning"
            showIcon
          />
        ) : (
          <Card title="Create Template">
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
                    <Option key={l.code} value={l.code}>
                      {l.name}
                      {' '}
(
                      {l.code}
)
                    </Option>
                  ))}
                </Select>
              </Form.Item>

              <Form.Item
                label="Body"
                name="body"
                extra={(
                  <span>
                    Use
                    {' '}
                    <Text code>{'{{1}}'}</Text>
,
                    {' '}
                    <Text code>{'{{2}}'}</Text>
, etc. for dynamic values.
                    In your survey, pass values via
                    {' '}
                    <Text code>params: [...]</Text>
                    {' '}
in the same order.
                    Max
                    {' '}
                    {MAX_BODY_LENGTH}
                    {' '}
characters.
                  </span>
                )}
                rules={[
                  { required: true, message: 'Body is required' },
                  { max: MAX_BODY_LENGTH, message: `Body must be at most ${MAX_BODY_LENGTH} characters` },
                  () => ({
                    validator(_, value) {
                      const idx = extractPlaceholderIndices(value);
                      for (let i = 0; i < idx.length; i++) {
                        if (idx[i] !== i + 1) {
                          return Promise.reject(new Error(
                            `Placeholders must be sequential starting from {{1}} (found {{${idx[i]}}} where {{${i + 1}}} expected)`,
                          ));
                        }
                      }
                      return Promise.resolve();
                    },
                  }),
                ]}
              >
                <TextArea
                  rows={4}
                  maxLength={MAX_BODY_LENGTH}
                  showCount
                  placeholder="Your {{1}} results are ready, {{2}}."
                  onChange={e => setPlaceholderIndices(extractPlaceholderIndices(e.target.value))}
                />
              </Form.Item>

              {placeholderIndices.length > 0 && (
                <Form.Item
                  label="Sample values for placeholders"
                  extra={(
                    <span>
                      Facebook requires a realistic example for every
                      {' '}
                      <Text code>{'{{N}}'}</Text>
                      {' '}
in the body.
                      These are only used at approval time — actual values come from
                      {' '}
                      <Text code>params</Text>
                      {' '}
at send time.
                    </span>
                  )}
                >
                  {placeholderIndices.map((n, i) => (
                    <Form.Item
                      key={n}
                      name={['examples', i]}
                      rules={[{ required: true, message: `Sample value for {{${n}}} is required`, whitespace: true }]}
                      style={{ marginBottom: 8 }}
                    >
                      <Input addonBefore={`{{${n}}}`} placeholder={`Sample value for {{${n}}}`} />
                    </Form.Item>
                  ))}
                </Form.Item>
              )}

              <Form.Item
                label="Quick-reply buttons (optional)"
                extra={(
                  <span>
                    Let users tap instead of typing. Up to
                    {' '}
                    {MAX_BUTTONS}
                    {' '}
buttons, label max
                    {' '}
                    {BUTTON_LABEL_MAX}
                    {' '}
chars.
                    Labels are
                    {' '}
                    <b>locked after Facebook approves the template</b>
                    {' '}
— to change them, delete and recreate.
                    In your survey JSON, pass
                    {' '}
                    <Text code>buttons: [&quot;value1&quot;, &quot;value2&quot;, ...]</Text>
                    {' '}
in the same order.
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
                          Add button
                          {' '}
                          {fields.length > 0 ? `(${fields.length}/${MAX_BUTTONS})` : ''}
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
                  <Button onClick={() => history.push('/message-templates')}>
                    Cancel
                  </Button>
                  <Text type="secondary">
                    Facebook does not allow editing utility templates.
                    To change wording, delete and recreate.
                  </Text>
                </Space>
              </Form.Item>
            </Form>
          </Card>
        )}
      </Content>
    </Layout>
  );
};

export default NewMessageTemplate;
