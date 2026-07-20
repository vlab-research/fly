import React, { useState, useEffect } from 'react';
import PropTypes from 'prop-types';
import {
  Alert, Avatar, Button, Card, Empty, Input, message, Space, Spin, Tag, Tooltip, Typography,
} from 'antd';
import { ArrowLeftOutlined, ExportOutlined } from '@ant-design/icons';
import { useParams } from 'react-router-dom';
import api from '../../services/api';
import Markdown from '../../components/Markdown';
import {
  initials, isClosed, tagColor, timeAgo,
} from './stateMeta';

const { Text, Link: AntLink } = Typography;
const { TextArea } = Input;

// Strip the trailing reporter marker from a body for display — it's a
// machine sentinel, not something the user needs to see in the thread.
function displayBody(body) {
  if (!body) return '';
  return body.replace(/\n\n\*vlab-reporter:[^\s*]+\*$/g, '').trim();
}

// Comments arrive from two disjoint paths: reporter-authored ones are posted
// via the dashboard and carry the reporter sentinel (shown as "You"), and
// everything else was written by a workspace member in Linear — i.e. the
// support team. Render the two sides distinctly.
function CommentRow({ comment }) {
  const isYou = !!comment.reporterEmail;
  const author = isYou ? 'You' : (comment.author || 'Support');
  return (
    <div className={`ticket-comment ${isYou ? 'you' : 'support'}`}>
      <div className="ticket-comment-meta">
        <Avatar
          size="small"
          style={{ backgroundColor: isYou ? '#1890ff' : '#52c41a', flex: 'none' }}
        >
          {initials(author)}
        </Avatar>
        <Text strong>{author}</Text>
        {!isYou && <Tag color="green">Support</Tag>}
        <Tooltip title={comment.createdAt ? new Date(comment.createdAt).toLocaleString() : ''}>
          <Text type="secondary" className="comment-time">
            {timeAgo(comment.createdAt)}
          </Text>
        </Tooltip>
      </div>
      <Markdown>{displayBody(comment.body)}</Markdown>
    </div>
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

const TicketDetail = ({ onBack, onActivity }) => {
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
      if (onActivity) onActivity();
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

  if (loading) {
    return (
      <div style={{ padding: '80px 0', textAlign: 'center' }}>
        <Spin />
      </div>
    );
  }

  if (notFound) {
    return (
      <div>
        {onBack && (
          <Button
            style={{ marginBottom: 16 }}
            icon={<ArrowLeftOutlined />}
            onClick={onBack}
          >
            All tickets
          </Button>
        )}
        <Alert
          type="error"
          message="Ticket not found"
          description="This ticket does not exist or you do not have access to it."
          showIcon
        />
      </div>
    );
  }

  const comments = Array.isArray(ticket.comments) ? ticket.comments : [];
  const closed = isClosed(ticket.state);

  return (
    <div>
      <Space style={{ marginBottom: 16 }} wrap>
        {onBack && (
          <Button icon={<ArrowLeftOutlined />} onClick={onBack}>
            All tickets
          </Button>
        )}
        {ticket.url && (
          <AntLink href={ticket.url} target="_blank" rel="noopener noreferrer">
            View in Linear
            {' '}
            <ExportOutlined />
          </AntLink>
        )}
      </Space>

      <Card style={{ marginBottom: 24 }}>
        <Space size="middle" wrap>
          <Text code>{ticket.identifier}</Text>
          <Tag color={tagColor(ticket.state)}>{ticket.state || '—'}</Tag>
        </Space>
        <h3 style={{ margin: '8px 0 4px' }}>{ticket.title}</h3>
        <Text type="secondary" className="ticket-detail-meta">
          Opened
          {' '}
          {ticket.createdAt ? new Date(ticket.createdAt).toLocaleString() : '—'}
          {' · '}
          Last activity
          {' '}
          {timeAgo(ticket.updatedAt)}
        </Text>
      </Card>

      <Card title="Description" style={{ marginBottom: 24 }}>
        <Markdown>{displayBody(ticket.description)}</Markdown>
      </Card>

      <Card title={`Conversation (${comments.length})`} style={{ marginBottom: 24 }}>
        {comments.length === 0 ? (
          <Empty description="No replies yet. Start the conversation below." />
        ) : (
          comments.map(c => <CommentRow key={c.id} comment={c} />)
        )}
      </Card>

      <Card title="Add a reply">
        {closed && (
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 12 }}
            message="This ticket is closed, but you can still reply — our support team will see it."
          />
        )}
        <TextArea
          rows={4}
          value={reply}
          onChange={e => setReply(e.target.value)}
          placeholder="Type your reply… Markdown formatting (**bold**, lists, links) is supported."
          disabled={replying}
        />
        <Space style={{ marginTop: 12 }}>
          <Button type="primary" onClick={onReply} loading={replying} disabled={!reply.trim()}>
            Post reply
          </Button>
        </Space>
      </Card>
    </div>
  );
};

TicketDetail.propTypes = {
  onBack: PropTypes.func,
  onActivity: PropTypes.func,
};

export default TicketDetail;
