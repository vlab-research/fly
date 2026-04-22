import React, { useState, useEffect } from 'react';
import {
  Layout, Card, Descriptions, Tag, Alert, Button, Typography, Space,
} from 'antd';
import {
  CheckCircleTwoTone, CloseCircleTwoTone, LoadingOutlined, ArrowLeftOutlined,
} from '@ant-design/icons';
import { useHistory, useParams } from 'react-router-dom';
import api from '../../services/api';
import { Loading } from '../../components/UI';
import LOCALES from './locales';

const { Content } = Layout;
const { Text, Paragraph } = Typography;

function statusTag(status) {
  if (status === 'PENDING') return <Tag icon={<LoadingOutlined />} color="processing">Pending</Tag>;
  if (status === 'APPROVED') {
    return (
      <Tag icon={<CheckCircleTwoTone twoToneColor="#52c41a" />} color="success">Approved</Tag>
    );
  }
  if (status === 'REJECTED') {
    return (
      <Tag icon={<CloseCircleTwoTone twoToneColor="#f5222d" />} color="error">Rejected</Tag>
    );
  }
  return <Tag>{status}</Tag>;
}

const TemplateDetail = () => {
  const history = useHistory();
  const { id } = useParams();
  const [template, setTemplate] = useState(null);
  const [pageMap, setPageMap] = useState({});
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const [tmplRes, pagesRes] = await Promise.all([
          api.fetcher({ path: `/message-templates/${id}` }),
          api.fetcher({ path: '/media/pages' }),
        ]);

        if (tmplRes.status === 404) {
          setNotFound(true);
          return;
        }

        const [tmpl, pages] = await Promise.all([tmplRes.json(), pagesRes.json()]);
        setTemplate(tmpl);
        setPageMap(pages.reduce((acc, p) => ({ ...acc, [p.id]: p.name }), {}));
      } catch (err) {
        console.error(err);
        setNotFound(true);
      } finally {
        setLoading(false);
      }
    })();
  }, [id]);

  if (loading) return <Loading>Loading template...</Loading>;

  if (notFound) {
    return (
      <Layout>
        <Content style={{ padding: '30px' }}>
          <Alert
            type="error"
            message="Template not found"
            description="This template does not exist or you do not have access to it."
            showIcon
          />
          <Button
            style={{ marginTop: 16 }}
            icon={<ArrowLeftOutlined />}
            onClick={() => history.push('/message-templates')}
          >
            Back to templates
          </Button>
        </Content>
      </Layout>
    );
  }

  const localeName = LOCALES.find(l => l.code === template.language);
  const languageLabel = localeName
    ? `${localeName.name} (${template.language})`
    : template.language;

  return (
    <Layout>
      <Content style={{ padding: '30px' }}>
        <Space style={{ marginBottom: 16 }}>
          <Button
            icon={<ArrowLeftOutlined />}
            onClick={() => history.push('/message-templates')}
          >
            Back to templates
          </Button>
        </Space>

        <Card title={<Text code>{template.name}</Text>} style={{ marginBottom: 24 }}>
          <Descriptions bordered column={1}>
            <Descriptions.Item label="Name">
              <Text code>{template.name}</Text>
            </Descriptions.Item>
            <Descriptions.Item label="Language">{languageLabel}</Descriptions.Item>
            <Descriptions.Item label="Page">
              {pageMap[template.facebook_page_id] || template.facebook_page_id}
            </Descriptions.Item>
            <Descriptions.Item label="Status">{statusTag(template.status)}</Descriptions.Item>
            <Descriptions.Item label="Submitted">
              {new Date(template.created).toLocaleString()}
            </Descriptions.Item>
          </Descriptions>
        </Card>

        {template.status === 'REJECTED' && template.rejection_reason && (
          <Alert
            type="error"
            message="Rejection reason"
            description={template.rejection_reason}
            showIcon
            style={{ marginBottom: 24 }}
          />
        )}

        <Card title="Message body" style={{ marginBottom: 24 }}>
          <Paragraph>
            <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontFamily: 'inherit' }}>
              {template.body}
            </pre>
          </Paragraph>
        </Card>

        {Array.isArray(template.buttons) && template.buttons.length > 0 && (
          <Card title="Buttons">
            <Space direction="vertical">
              {template.buttons.map((b, i) => (
                <Text key={b.label}>
                  {i + 1}
.
                  {' '}
                  {b.label}
                </Text>
              ))}
            </Space>
          </Card>
        )}
      </Content>
    </Layout>
  );
};

export default TemplateDetail;
