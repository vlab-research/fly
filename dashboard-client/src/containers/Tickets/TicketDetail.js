import React, { useState, useEffect } from 'react';
import PropTypes from 'prop-types';
import {
  Layout, Card, Descriptions, Tag, Alert, Button, Typography, Space,
  Input, message, Empty,
} from 'antd';
import { ArrowLeftOutlined } from '@ant-design/icons';
import { useHistory, useParams } from 'react-router-dom';
import api from '../../services/api';
import { Loading } from '../../components/UI';

const { Content } = Layout;
const { Text, Paragraph, Link: AntLink } = Typography;
const { TextArea } = Input;

const STATE_COLORS = {
  Backlog: 'default',
  Triaged: 'blue',
  'In Progress': 'processing',
  'In Review': 'cyan',
  Done: 'success',
  Canceled: 'default',
};

function stateTag(state) {
  const color = STATE_COLORS[state] || 'default';
  return <Tag color={color}>{state || '—'}</Tag>;
}

// Strip the trailing reporter marker from a body for display — it's a
// machine sentinel, not something the user needs to see in the thread.
function displayBody(body) {
  if (!body) return '';
  return body.replace(/\n\n\*vlab-reporter:[^\s*]+\*$/g, '').trim();
}

function CommentRow({ comment }) {
  const isYou = !!comment.reporterEmail;
  const author = isYou ? 'You' : (comment.author || 'Linear');
  return (
    <Card size="small" style={{ marginBottom: 12 }}>
      <div style={{ marginBottom: 4 }}>
        <Text strong>{author}</Text>
        <Text type="secondary" style={{ marginLeft: 8 }}>
          {comment.createdAt ? new Date(comment.createdAt).toLocaleString() : ''}
        </Text>
      </div>
      <Paragraph style={{ marginBottom: 0 }}>
        <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontFamily: 'inherit' }}>
          {displayBody(comment.body)}
        </pre>
      </Paragraph>
    </Card>
  );
}

CommentRow.propTypes = {
  comment: PropTypes.shape({
    id: PropTypes.string,
    body: PropTypes.string,
    createdAt: PropTypes.string,
    author: PropTypes.string,
    reporterEmail: PropTypes.string,
  }).isRequired,
};

const TicketDetail = () => {
  const history = useHistory();
  const { id } = useParams();
  const [ticket, setTicket] = useState(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [reply, setReply] = useState('');
  const [replying, setReplying] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.fetcher({ path: `/tickets/${encodeURIComponent(id)}` });
        if (res.status === 404) {
          if (!cancelled) setNotFound(true);
          return;
        }
        const data = await res.json();
        if (cancelled) return;
        setTicket(data);
      } catch (err) {
        console.error(err);
        if (!cancelled) setNotFound(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [id]);

  const onReply = async () => {
    if (!reply.trim()) {
      message.warning('Reply cannot be empty');
      return;
    }
    setReplying(true);
    try {
      const res = await api.fetcher({
        path: `/tickets/${encodeURIComponent(id)}/replies`,
        method: 'POST',
        body: { body: reply },
      });
      const comment = await res.json();
      setTicket(prev => (prev ? { ...prev, comments: [...(prev.comments || []), comment] } : prev));
      setReply('');
      message.success('Reply posted');
    } catch (err) {
      let msg = 'Failed to post reply';
      try {
        msg = JSON.parse(err.message).error || msg;
      } catch (_) { msg = err.message || msg; }
      message.error(`Reply failed: ${msg}`);
    } finally {
      setReplying(false);
    }
  };

  if (loading) return <Loading>Loading ticket…</Loading>;

  if (notFound) {
    return (
      <Layout>
        <Content style={{ padding: '30px' }}>
          <Alert
            type="error"
            message="Ticket not found"
            description="This ticket does not exist or you do not have access to it."
            showIcon
          />
          <Button
            style={{ marginTop: 16 }}
            icon={<ArrowLeftOutlined />}
            onClick={() => history.push('/tickets')}
          >
            Back to tickets
          </Button>
        </Content>
      </Layout>
    );
  }

  const comments = Array.isArray(ticket.comments) ? ticket.comments : [];

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
          {ticket.url && (
            <AntLink href={ticket.url} target="_blank" rel="noopener noreferrer">
              View in Linear
            </AntLink>
          )}
        </Space>

        <Card
          title={(
            <Space>
              <Text code>{ticket.identifier}</Text>
              <Text>{ticket.title}</Text>
            </Space>
          )}
          style={{ marginBottom: 24 }}
        >
          <Descriptions bordered column={1}>
            <Descriptions.Item label="State">{stateTag(ticket.state)}</Descriptions.Item>
            <Descriptions.Item label="Created">
              {ticket.createdAt ? new Date(ticket.createdAt).toLocaleString() : '—'}
            </Descriptions.Item>
            <Descriptions.Item label="Updated">
              {ticket.updatedAt ? new Date(ticket.updatedAt).toLocaleString() : '—'}
            </Descriptions.Item>
          </Descriptions>
        </Card>

        <Card title="Description" style={{ marginBottom: 24 }}>
          <Paragraph>
            <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontFamily: 'inherit' }}>
              {displayBody(ticket.description)}
            </pre>
          </Paragraph>
        </Card>

        <Card title="Conversation" style={{ marginBottom: 24 }}>
          {comments.length === 0 ? (
            <Empty description="No replies yet. Start the conversation below." />
          ) : (
            comments.map(c => <CommentRow key={c.id} comment={c} />)
          )}
        </Card>

        <Card title="Add a reply">
          <TextArea
            rows={4}
            value={reply}
            onChange={e => setReply(e.target.value)}
            placeholder="Type your reply…"
            disabled={replying}
          />
          <Space style={{ marginTop: 12 }}>
            <Button type="primary" onClick={onReply} loading={replying} disabled={!reply.trim()}>
              Post reply
            </Button>
          </Space>
        </Card>
      </Content>
    </Layout>
  );
};

export default TicketDetail;
