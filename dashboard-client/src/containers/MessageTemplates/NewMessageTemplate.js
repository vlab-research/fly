import React, { useState, useEffect } from 'react';
import {
  Layout, Select, Row, Col, message, Card,
  Input, Button, Form, Alert, Space, Typography,
} from 'antd';
import { MinusCircleOutlined, PlusOutlined } from '@ant-design/icons';
import { useHistory, useLocation } from 'react-router-dom';
import api from '../../services/api';
import { Loading } from '../../components/UI';
import LOCALES from './locales';
import fetchMessagingAccounts from './accounts';

const { Content } = Layout;
const { Option } = Select;
const { TextArea } = Input;
const { Text } = Typography;

const NAME_PATTERN = /^[a-z0-9_]+$/;
const MAX_BODY_LENGTH = 1024;
const MAX_BUTTONS = 3;
const BUTTON_LABEL_MAX = 20;
const PLACEHOLDER_PATTERN = /\{\{(\d+)\}\}/g;

// Meta reserves the name of a *deleted approved* template for 30 days; a name
// that simply exists on the target account is a different problem with a
// different remedy. Both arrive as opaque Graph errors, so match on the text.
const NAME_RESERVED = /30 days|recently deleted|reserved/i;
const NAME_TAKEN = /already exists|duplicate/i;

const explainCreateError = (raw, { name, language, accountName }) => {
  if (NAME_RESERVED.test(raw)) {
    return `"${name}" was deleted from ${accountName} less than 30 days ago and Meta still `
      + 'reserves the name. Wait out the reservation or create it under a different name '
      + `(Meta said: ${raw})`;
  }
  if (NAME_TAKEN.test(raw)) {
    return `${accountName} already has a template named "${name}" in ${language}. `
      + 'Duplicate it to a different account, or change the language.';
  }
  return `Create failed: ${raw}`;
};

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
  const location = useLocation();
  const duplicateId = new URLSearchParams(location.search).get('duplicate');
  const [pages, setPages] = useState([]);
  const [selectedPage, setSelectedPage] = useState(undefined);
  const [source, setSource] = useState(null);
  const [initialValues, setInitialValues] = useState({ language: 'en_US' });
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [placeholderIndices, setPlaceholderIndices] = useState([]);
  const [form] = Form.useForm();

  useEffect(() => {
    (async () => {
      try {
        const data = await fetchMessagingAccounts();
        setPages(data);

        // Duplicating: prefill name, language, body and buttons from an
        // existing registration so the shape cannot drift through retyping.
        // The account is deliberately left unpicked — choosing it is the
        // whole point of the action. Sample values are not prefilled because
        // they are never stored; Meta only needs them at approval time.
        let src = null;
        if (duplicateId) {
          try {
            const res = await api.fetcher({ path: `/message-templates/${duplicateId}` });
            src = await res.json();
            setSource(src);
            setInitialValues({
              name: src.name,
              language: src.language,
              body: src.body,
              buttons: (Array.isArray(src.buttons) ? src.buttons : [])
                .map(b => ({ label: b.label })),
            });
            setPlaceholderIndices(extractPlaceholderIndices(src.body));
          } catch (err) {
            message.error('Could not load the template to duplicate');
            console.error(err);
          }
        }

        // With a single account there is nothing to pick — unless that one
        // account is the one we are duplicating away from.
        if (data.length === 1 && (!src || data[0].id !== src.account_id)) {
          setSelectedPage(data[0].id);
        }
      } catch (err) {
        message.error('Failed to load accounts');
        console.error(err);
      } finally {
        setLoading(false);
      }
    })();
  }, [duplicateId]);

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
          accountId: selectedPage,
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
      const account = pages.find(p => p.id === selectedPage);
      message.error(explainCreateError(errorMsg, {
        name: values.name,
        language: values.language,
        accountName: (account && account.name) || 'That account',
      }), 8);
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) return <Loading>Loading accounts...</Loading>;

  const selectedAccount = pages.find(p => p.id === selectedPage);
  const isWhatsApp = !!selectedAccount && selectedAccount.platform === 'whatsapp';
  const sourceAccount = source && pages.find(p => p.id === source.account_id);
  // Kept a plain string: the Select filters on option children.
  const accountOptionLabel = p => (
    source && p.id === source.account_id ? `${p.name} (source)` : p.name
  );

  return (
    <Layout>
      <Content style={{ padding: '30px' }}>
        <h2>{source ? 'Duplicate Message Template' : 'New Message Template'}</h2>

        {pages.length === 0 ? (
          <Alert
            message="No messaging accounts connected"
            description={(
              <span>
                Please
                {' '}
                <a href="/connect/facebook-messenger">connect a Facebook page</a>
                {' '}
                or
                {' '}
                <a href="/connect/whatsapp">connect a WhatsApp Business number</a>
                {' '}
before creating templates.
              </span>
            )}
            type="warning"
            showIcon
          />
        ) : (
          <Card title={source ? 'Duplicate Template' : 'Create Template'}>
            {source && (
              <Alert
                style={{ marginBottom: 16 }}
                type="info"
                showIcon
                message={(
                  <span>
                    Duplicating
                    {' '}
                    <Text code>{source.name}</Text>
                    {' '}
                    from
                    {' '}
                    {(sourceAccount && sourceAccount.name) || source.account_id}
                  </span>
                )}
                description={(
                  <span>
                    Pick the account to create it on. Keep the body&apos;s placeholder
                    count and the button count and order the same — a survey supplies
                    one
                    {' '}
                    <Text code>params</Text>
                    {' '}
                    list and one set of choices to every platform, so a mismatch only
                    shows up as a failed send. The wording itself may differ freely.
                    Sample values are not copied and must be re-entered.
                  </span>
                )}
              />
            )}
            <Row gutter={16} style={{ marginBottom: 16 }}>
              <Col span={12}>
                <Select
                  showSearch
                  placeholder="Select account"
                  value={selectedPage}
                  onChange={setSelectedPage}
                  style={{ width: '100%' }}
                  optionFilterProp="children"
                >
                  {pages.map(p => (
                    <Option key={p.id} value={p.id}>{accountOptionLabel(p)}</Option>
                  ))}
                </Select>
              </Col>
            </Row>

            {isWhatsApp && (
              <Alert
                style={{ marginBottom: 16 }}
                type="info"
                showIcon
                message="WhatsApp template"
                description={(
                  <span>
                    This template will be created on the WhatsApp Business Account
                    linked to this number and reviewed by WhatsApp.
                    Sample values are
                    {' '}
                    <b>required</b>
                    {' '}
                    for every placeholder, and buttons are sent as WhatsApp
                    quick replies.
                  </span>
                )}
              />
            )}

            <Form
              form={form}
              layout="vertical"
              onFinish={onSubmit}
              initialValues={initialValues}
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
