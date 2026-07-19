import React, { useState, useEffect } from 'react';
import {
  Layout, Select, Row, Col, message, Card,
  Input, Button, Form, Alert, Space, Typography,
} from 'antd';
import { ArrowLeftOutlined } from '@ant-design/icons';
import { useHistory } from 'react-router-dom';
import api from '../../services/api';
import { Loading } from '../../components/UI';

const { Content } = Layout;
const { Option } = Select;
const { TextArea } = Input;
const { Text, Paragraph } = Typography;

const MAX_TITLE = 256;
const MAX_DESCRIPTION = 20000;
const MAX_USER_IDS = 200;

const NewTicket = () => {
  const history = useHistory();
  const [surveys, setSurveys] = useState([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm();

  useEffect(() => {
    (async () => {
      try {
        const res = await api.fetcher({ path: '/surveys' });
        const data = await res.json();
        const list = Array.isArray(data) ? data : [];
        // Unique survey_name values, sorted — a survey_name is the right
        // granularity for "which survey is impacted" since one name may
        // span multiple form versions/shortcodes.
        const names = Array.from(new Set(list.map(s => s.survey_name).filter(Boolean)))
          .sort((a, b) => a.localeCompare(b));
        setSurveys(names);
      } catch (err) {
        // Non-fatal — the dropdown is optional; user can still file a ticket.
        console.error('Failed to load surveys for dropdown:', err);
        setSurveys([]);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const onSubmit = async (values) => {
    setSubmitting(true);
    try {
      const res = await api.fetcher({
        path: '/tickets',
        method: 'POST',
        body: {
          title: values.title,
          description: values.description,
          surveyName: values.surveyName || undefined,
          userIds: values.userIds || undefined,
        },
      });
      const ticket = await res.json();
      message.success('Ticket created');
      history.push(`/tickets/${encodeURIComponent(ticket.id)}`);
    } catch (err) {
      let msg = 'Failed to create ticket';
      try {
        msg = JSON.parse(err.message).error || msg;
      } catch (_) { msg = err.message || msg; }
      message.error(`Create failed: ${msg}`);
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) return <Loading>Loading surveys…</Loading>;

  return (
    <Layout>
      <Content style={{ padding: '30px' }}>
        <Space style={{ marginBottom: 16 }}>
          <Button
            icon={<ArrowLeftOutlined />}
            onClick={() => history.push('/tickets')}
          >
            Back to tickets
          </Button>
        </Space>

        <h2>New Support Ticket</h2>

        <Card title="Create a support ticket">
          <Paragraph type="secondary">
            Tell us what&apos;s going on. The more context you add, the faster we
            can help. Tickets are tracked in Linear; you&apos;ll see replies here.
          </Paragraph>

          <Form
            form={form}
            layout="vertical"
            onFinish={onSubmit}
            disabled={submitting}
          >
            <Form.Item
              label="Title"
              name="title"
              rules={[
                { required: true, message: 'Title is required' },
                { max: MAX_TITLE, message: `Title must be at most ${MAX_TITLE} characters` },
              ]}
            >
              <Input placeholder="e.g. Form 305 stuck on payment for multiple users" maxLength={MAX_TITLE} showCount />
            </Form.Item>

            <Form.Item
              label="Description"
              name="description"
              extra="Describe the problem in detail. What happened, what you expected, and any steps to reproduce. Markdown formatting (**bold**, lists, links) is supported."
              rules={[
                { required: true, message: 'Description is required' },
                { max: MAX_DESCRIPTION, message: `Description must be at most ${MAX_DESCRIPTION} characters` },
              ]}
            >
              <TextArea
                rows={6}
                maxLength={MAX_DESCRIPTION}
                showCount
                placeholder="Users on form 305 report being asked for payment repeatedly after completing the payment step. This started on…"
              />
            </Form.Item>

            <Row gutter={16}>
              <Col span={12}>
                <Form.Item
                  label="Impacted survey"
                  name="surveyName"
                  extra={surveys.length === 0 ? 'No surveys found — you can still submit without one.' : 'Pick the survey this is about (optional).'}
                >
                  <Select
                    showSearch
                    allowClear
                    placeholder="Select a survey (optional)"
                    optionFilterProp="children"
                    filterOption={(input, option) => (
                      (option.children || '').toString().toLowerCase().includes(input.toLowerCase())
                    )}
                  >
                    {surveys.map(name => (
                      <Option key={name} value={name}>{name}</Option>
                    ))}
                  </Select>
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item
                  label="Impacted user IDs"
                  name="userIds"
                  extra={(
                    <span>
                      Comma, space, or newline separated.
                      {' '}
                      <Text type="secondary">
Up to
                        {MAX_USER_IDS}
.
                      </Text>
                    </span>
                  )}
                >
                  <TextArea
                    rows={1}
                    placeholder="e.g. 105839823491, 298471029384"
                    autoSize={{ minRows: 1, maxRows: 4 }}
                  />
                </Form.Item>
              </Col>
            </Row>

            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 16 }}
              message="These details are sent to our support team via Linear."
              description="The survey and user IDs you provide are attached to the ticket so we can investigate faster."
            />

            <Form.Item>
              <Space>
                <Button type="primary" htmlType="submit" loading={submitting}>
                  Create ticket
                </Button>
                <Button onClick={() => history.push('/tickets')}>
                  Cancel
                </Button>
              </Space>
            </Form.Item>
          </Form>
        </Card>
      </Content>
    </Layout>
  );
};

export default NewTicket;
