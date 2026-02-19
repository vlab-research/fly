import React, { useState, useEffect } from 'react';
import { Layout, Table, Select, Upload, Row, Col, Tag, message, Card, Radio, Spin, Typography, Alert } from 'antd';
import { InboxOutlined } from '@ant-design/icons';
import api from '../../services/api';
import { Loading } from '../../components/UI';

const { Content } = Layout;
const { Option } = Select;
const { Text } = Typography;

const Media = () => {
  const [pages, setPages] = useState([]);
  const [selectedPage, setSelectedPage] = useState(undefined);
  const [mediaType, setMediaType] = useState('image');
  const [uploading, setUploading] = useState(false);
  const [mediaList, setMediaList] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadInitialData();
  }, []);

  const loadInitialData = async () => {
    try {
      const [pagesRes, mediaRes] = await Promise.all([
        api.fetcher({ path: '/media/pages' }),
        api.fetcher({ path: '/media' }),
      ]);
      const pagesData = await pagesRes.json();
      const mediaData = await mediaRes.json();
      setPages(pagesData);
      setMediaList(mediaData);
    } catch (err) {
      message.error('Failed to load media data');
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const handleUpload = async (file) => {
    if (!selectedPage) {
      message.error('Please select a page first');
      return false;
    }

    setUploading(true);
    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('pageId', selectedPage);
      formData.append('mediaType', mediaType);

      const res = await api.fetcher({
        path: '/media/upload',
        method: 'POST',
        body: formData,
      });
      const record = await res.json();
      setMediaList([record, ...mediaList]);
      message.success(`Uploaded! Attachment ID: ${record.attachment_id}`);
    } catch (err) {
      let errorMsg = 'Unknown error';
      try {
        const parsed = JSON.parse(err.message);
        errorMsg = parsed.error?.message || parsed.error || err.message;
      } catch (_) {
        errorMsg = err.message || errorMsg;
      }
      message.error('Upload failed: ' + errorMsg);
      console.error(err);
    } finally {
      setUploading(false);
    }

    return false;
  };

  const pageNameMap = pages.reduce((acc, p) => {
    acc[p.id] = p.name;
    return acc;
  }, {});

  const columns = [
    {
      title: 'Filename',
      dataIndex: 'filename',
      key: 'filename',
    },
    {
      title: 'Type',
      dataIndex: 'media_type',
      key: 'media_type',
      render: (type) => (
        <Tag color={type === 'image' ? 'green' : 'blue'}>{type}</Tag>
      ),
    },
    {
      title: 'Attachment ID',
      dataIndex: 'attachment_id',
      key: 'attachment_id',
      render: (id) => <Text copyable>{id}</Text>,
    },
    {
      title: 'Page',
      dataIndex: 'facebook_page_id',
      key: 'facebook_page_id',
      render: (pageId) => pageNameMap[pageId] || pageId,
    },
    {
      title: 'Uploaded',
      dataIndex: 'created',
      key: 'created',
      render: (d) => new Date(d).toLocaleDateString(),
    },
  ];

  if (loading) return <Loading>Loading media...</Loading>;

  return (
    <Layout>
      <Content style={{ padding: '30px' }}>
        <h2>Media</h2>

        <Card title="Upload Media" style={{ marginBottom: 24 }}>
          {pages.length === 0 ? (
            <Alert
              message="No Facebook pages connected"
              description={
                <span>
                  Please <a href="/connect/facebook-messenger">connect a Facebook page</a> before uploading media.
                </span>
              }
              type="warning"
              showIcon
            />
          ) : (
            <>
              <Row gutter={16} style={{ marginBottom: 16 }}>
                <Col span={8}>
                  <Select
                    placeholder="Select page"
                    onChange={setSelectedPage}
                    value={selectedPage}
                    style={{ width: '100%' }}
                  >
                    {pages.map(p => (
                      <Option key={p.id} value={p.id}>{p.name}</Option>
                    ))}
                  </Select>
                </Col>
                <Col span={8}>
                  <Radio.Group value={mediaType} onChange={e => setMediaType(e.target.value)}>
                    <Radio.Button value="image">Image</Radio.Button>
                    <Radio.Button value="video">Video</Radio.Button>
                  </Radio.Group>
                </Col>
              </Row>
              <Upload.Dragger
                beforeUpload={handleUpload}
                accept={mediaType === 'image' ? 'image/*' : 'video/*'}
                showUploadList={false}
                disabled={!selectedPage || uploading}
              >
                <p className="ant-upload-drag-icon">
                  <InboxOutlined />
                </p>
                <p>Click or drag file to upload</p>
              </Upload.Dragger>
              {uploading && <Spin tip="Uploading to Facebook..." style={{ marginTop: 16, display: 'block' }} />}
            </>
          )}
        </Card>

        <Card title="Uploaded Media">
          <Table
            dataSource={mediaList}
            rowKey="id"
            columns={columns}
            pagination={{ pageSize: 20 }}
          />
        </Card>
      </Content>
    </Layout>
  );
};

export default Media;
