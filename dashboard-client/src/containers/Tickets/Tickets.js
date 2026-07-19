import React, { useState, useEffect, useCallback } from 'react';
import {
  Alert, Button, Empty, Grid, Layout, message,
} from 'antd';
import { useHistory, useParams } from 'react-router-dom';
import api from '../../services/api';
import { Loading } from '../../components/UI';
import TicketList from './TicketList';
import TicketDetail from './TicketDetail';
import './Tickets.css';

const { Content } = Layout;

const Tickets = () => {
  const history = useHistory();
  const { id } = useParams();
  const screens = Grid.useBreakpoint();
  const isSplit = !!screens.lg;

  const [tickets, setTickets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState(null);

  const loadTickets = useCallback(async (initial) => {
    if (initial) setLoading(true);
    else setRefreshing(true);
    setLoadError(null);
    try {
      const res = await api.fetcher({ path: '/tickets' });
      const data = await res.json();
      setTickets(Array.isArray(data) ? data : []);
    } catch (err) {
      let msg = 'Failed to load tickets';
      try {
        msg = JSON.parse(err.message).error || msg;
      } catch (_) { msg = err.message || msg; }
      if (initial) setLoadError(msg);
      else message.error(msg);
      console.error(err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    loadTickets(true);
  }, [loadTickets]);

  if (loading) return <Loading>Loading tickets…</Loading>;

  if (loadError) {
    return (
      <Layout>
        <Content style={{ padding: '30px' }}>
          <Alert
            type="error"
            showIcon
            message="Could not load tickets"
            description={loadError}
          />
          <Button style={{ marginTop: 16 }} onClick={() => loadTickets(true)}>
            Retry
          </Button>
        </Content>
      </Layout>
    );
  }

  // Split view (large screens): list + detail side by side.
  // Narrow view: the list OR the detail, one at a time, with a back button.
  const showList = isSplit || !id;
  const showDetail = isSplit || !!id;

  const detail = id ? (
    <TicketDetail
      key={id}
      onBack={isSplit ? undefined : () => history.push('/tickets')}
      onActivity={() => loadTickets(false)}
    />
  ) : (
    <Empty
      className="ticket-detail-empty"
      description="Select a ticket from the list to read the conversation, or file a new one."
    />
  );

  return (
    <Layout>
      <Content style={{ padding: isSplit ? '24px 30px' : '16px' }}>
        <div className={`tickets-inbox${isSplit ? ' split' : ''}`}>
          {showList && (
            <div className="ticket-list-pane">
              <TicketList
                tickets={tickets}
                selectedId={id}
                onRefresh={() => loadTickets(false)}
                refreshing={refreshing}
              />
            </div>
          )}
          {showDetail && (
            <div className="ticket-detail-pane">
              {detail}
            </div>
          )}
        </div>
      </Content>
    </Layout>
  );
};

export default Tickets;
