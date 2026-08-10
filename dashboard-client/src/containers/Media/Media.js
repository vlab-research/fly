import React, { useState, useEffect, useCallback } from 'react';
import {
  Layout, Table, Upload, Tag, message, Card, Spin, Typography, Alert,
  Button, Popconfirm,
} from 'antd';
import { InboxOutlined } from '@ant-design/icons';
import PropTypes from 'prop-types';
import api from '../../services/api';
import { Loading } from '../../components/UI';
import {
  formatBytes, parseApiError, mergeAsset, isPreviewable,
} from './format';

const { Content } = Layout;
const { Text, Paragraph } = Typography;

/*
 * The media library (planning/media-abstraction.md §3).
 *
 * A researcher uploads a file and gets back a URL to paste into their survey.
 * That is the whole feature, and copy-to-clipboard is therefore the primary
 * action on this page.
 *
 * THREE THINGS ARE DELIBERATELY ABSENT.
 *
 * 1. No page/account selector. Asset creation is platform-independent (§3), so
 *    there is no account for the author to choose and no connected-page
 *    requirement — a researcher with zero connected accounts uploads fine.
 *    GET /media/pages was deleted server-side along with the concept; this page
 *    used to call it, and 404'd on load as a result.
 *
 * 2. No handle state. No "uploaded to N accounts", no expiry, no platform
 *    anything. §3: "Handle state is not shown — it is our problem." Surfacing
 *    it would put the platform detail back on the authoring surface, which is
 *    the thing this whole build exists to remove.
 *
 * 3. No client-side size or type validation, and no `accept` filter on the
 *    dragger. The server owns eligibility (§11.5), and a second copy of those
 *    rules here could only ever drift out of agreement with it — refusing a
 *    file the server would take, or promising one it will refuse. The server's
 *    refusal is specific and actionable; our job is to show it, not to
 *    anticipate it.
 */

// Uploads are refused, never repaired (§11.5), so the refusal has to be
// readable and stay on screen while the researcher fixes the file. A toast
// disappears; this does not.
const UploadError = ({ error, onClose }) => (
  <Alert
    type="error"
    showIcon
    closable
    onClose={onClose}
    style={{ marginBottom: 16 }}
    message="This file was not uploaded"
    description={(
      <>
        <Paragraph style={{ marginBottom: 4 }}>{error}</Paragraph>
        <Text type="secondary">
          We don&apos;t resize or convert files — please fix the file and upload it again.
        </Text>
      </>
    )}
  />
);

UploadError.propTypes = {
  error: PropTypes.string.isRequired,
  onClose: PropTypes.func.isRequired,
};

// §4.6, in researcher-facing terms. Asset URLs are capability URLs: unguessable
// and not listed anywhere, but permanently readable by anyone who ends up with
// one. It sits directly above the URLs it is about, not in a footnote.
const LinkWarning = () => (
  <Alert
    type="warning"
    showIcon
    style={{ marginBottom: 16 }}
    message="Anyone with the link can view the file, forever"
    description={(
      <>
        These links aren&apos;t listed anywhere and can&apos;t be guessed, but they
        need no password: anyone you send one to — or anyone it gets forwarded to —
        can open the file, indefinitely.
        {' '}
        <strong>Don&apos;t upload anything confidential.</strong>
        {' '}
        Survey images, audio and documents meant for respondents are exactly right.
      </>
    )}
  />
);

// The exact MIME type is a tooltip rather than a column: it is what the server
// sniffed and therefore what its size limit was applied against, so it is worth
// being able to see — but it is not what a researcher is scanning the list for.
function renderType(type, asset) {
  return <Tag color={type === 'image' ? 'green' : 'blue'} title={asset.mimeType}>{type}</Tag>;
}

const Media = () => {
  const [assets, setAssets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState(null);

  const loadAssets = useCallback(async () => {
    try {
      const res = await api.fetcher({ path: '/media' });
      setAssets(await res.json());
    } catch (err) {
      message.error(`Failed to load media: ${parseApiError(err, 'unknown error')}`);
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadAssets(); }, [loadAssets]);

  // Returning false keeps antd's Upload from doing its own XHR — we post it
  // ourselves so the response body (and its error) is ours to handle.
  const handleUpload = async (file) => {
    setUploading(true);
    setUploadError(null);
    try {
      const formData = new FormData();
      formData.append('file', file);

      const res = await api.fetcher({ path: '/media/upload', method: 'POST', body: formData });
      const asset = await res.json();

      // 200 means this researcher had already uploaded these exact bytes and
      // got the existing asset back; mergeAsset keeps it a single row.
      setAssets(prev => mergeAsset(prev, asset));
      message.success(
        res.status === 200
          ? `${asset.filename} was already in your library — its URL is below`
          : `${asset.filename} uploaded — copy its URL below`,
      );
    } catch (err) {
      // The server's message, verbatim and on screen. See parseApiError.
      setUploadError(parseApiError(err));
      console.error(err);
    } finally {
      setUploading(false);
    }
    return false;
  };

  const handleDelete = async (asset) => {
    try {
      await api.fetcher({ path: `/media/${asset.id}`, method: 'DELETE' });
      setAssets(prev => prev.filter(a => a.id !== asset.id));
      message.success(`${asset.filename} deleted`);
    } catch (err) {
      message.error(`Delete failed: ${parseApiError(err, 'unknown error')}`);
      console.error(err);
    }
  };

  const renderPreview = (_, asset) => {
    if (!isPreviewable(asset)) return <Text type="secondary">—</Text>;
    return (
      <img
        src={asset.url}
        alt={asset.filename}
        style={{
          width: 56, height: 56, objectFit: 'cover', borderRadius: 2, background: '#f5f5f5',
        }}
      />
    );
  };

  const renderUrl = (url, asset) => (
    <Text
      copyable={{
        text: url,
        tooltips: ['Copy URL', 'Copied'],
        onCopy: () => message.success(`URL for ${asset.filename} copied — paste it into your survey`),
      }}
      style={{ wordBreak: 'break-all' }}
    >
      <Text code style={{ fontSize: 12 }}>{url}</Text>
    </Text>
  );

  // §11.6: there is NO reference counting against surveys. A running survey
  // that references this asset will silently show a broken file, so the
  // confirmation says so plainly instead of asking "are you sure?".
  const renderActions = (_, asset) => (
    <Popconfirm
      title={(
        <div style={{ maxWidth: 320 }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>
            Delete
            {' '}
            {asset.filename}
            ?
          </div>
          <div>
            If any survey still uses this link, the file will stop loading for
            respondents straight away. We can&apos;t check that for you, and this
            can&apos;t be undone — the file is deleted for good.
          </div>
        </div>
      )}
      okText="Delete"
      okButtonProps={{ danger: true }}
      cancelText="Keep"
      onConfirm={() => handleDelete(asset)}
    >
      <Button danger size="small" type="link">Delete</Button>
    </Popconfirm>
  );

  const columns = [
    {
      title: '', key: 'preview', width: 72, render: renderPreview,
    },
    {
      title: 'Filename',
      dataIndex: 'filename',
      key: 'filename',
      sorter: (a, b) => String(a.filename).localeCompare(String(b.filename)),
    },
    {
      title: 'Type',
      dataIndex: 'mediaType',
      key: 'mediaType',
      width: 100,
      render: renderType,
    },
    {
      title: 'Size',
      dataIndex: 'byteSize',
      key: 'byteSize',
      width: 100,
      render: formatBytes,
      sorter: (a, b) => a.byteSize - b.byteSize,
    },
    {
      title: 'URL', dataIndex: 'url', key: 'url', render: renderUrl,
    },
    {
      title: 'Uploaded',
      dataIndex: 'created',
      key: 'created',
      width: 120,
      render: d => new Date(d).toLocaleDateString(),
      sorter: (a, b) => new Date(a.created) - new Date(b.created),
    },
    {
      title: '', key: 'actions', width: 90, render: renderActions,
    },
  ];

  if (loading) return <Loading>Loading media...</Loading>;

  return (
    <Layout>
      <Content style={{ padding: '30px' }}>
        <h2>Media</h2>

        <Card title="Upload a file" style={{ marginBottom: 24 }}>
          {uploadError && (
            <UploadError error={uploadError} onClose={() => setUploadError(null)} />
          )}
          <Upload.Dragger
            beforeUpload={handleUpload}
            showUploadList={false}
            disabled={uploading}
            multiple={false}
          >
            <p className="ant-upload-drag-icon"><InboxOutlined /></p>
            <p>Click or drag a file to upload</p>
            <p className="ant-upload-hint">
              Images, video, audio and documents. You&apos;ll get a link to paste
              into your survey — no need to connect an account first.
            </p>
          </Upload.Dragger>
          {uploading && <Spin tip="Uploading..." style={{ marginTop: 16, display: 'block' }} />}
        </Card>

        <Card title="Your media">
          <LinkWarning />
          <Table
            dataSource={assets}
            rowKey="id"
            columns={columns}
            pagination={{ pageSize: 20 }}
            locale={{ emptyText: 'No media yet — upload a file above to get a link for your survey.' }}
          />
        </Card>
      </Content>
    </Layout>
  );
};

export default Media;
