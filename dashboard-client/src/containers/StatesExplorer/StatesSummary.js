import React, { useState, useEffect } from 'react';
import PropTypes from 'prop-types';
import { Card, Table, Tag, Statistic, Row, Col, message } from 'antd';
import api from '../../services/api';
import { Loading } from '../../components/UI';

const StatesSummary = ({ surveyName }) => {
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadSummary();
  }, [surveyName]);

  const loadSummary = async () => {
    try {
      const res = await api.fetcher({
        path: `/surveys/${encodeURIComponent(surveyName)}/states/summary`
      });
      const data = await res.json();
      setSummary(data.summary || []);
    } catch (err) {
      message.error('Failed to load states summary');
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  if (loading) return <Loading>Loading states summary...</Loading>;

  // Compute aggregate stats
  const totalParticipants = summary.reduce((sum, row) => sum + row.count, 0);

  const stateCounts = summary.reduce((acc, row) => {
    acc[row.current_state] = (acc[row.current_state] || 0) + row.count;
    return acc;
  }, {});

  // State color mapping for consistent visual indicators
  const stateColors = {
    START: 'blue',
    RESPONDING: 'green',
    QOUT: 'cyan',
    END: 'default',
    BLOCKED: 'red',
    ERROR: 'red',
    WAIT_EXTERNAL_EVENT: 'orange',
    USER_BLOCKED: 'magenta',
  };

  const columns = [
    {
      title: 'Form',
      dataIndex: 'current_form',
      key: 'current_form',
      sorter: (a, b) => a.current_form.localeCompare(b.current_form),
    },
    {
      title: 'State',
      dataIndex: 'current_state',
      key: 'current_state',
      render: (state) => (
        <Tag color={stateColors[state] || 'default'}>
          {state}
        </Tag>
      ),
    },
    {
      title: 'Count',
      dataIndex: 'count',
      key: 'count',
      align: 'right',
      sorter: (a, b) => a.count - b.count,
      defaultSortOrder: 'descend',
    },
  ];

  return (
    <div>
      <Card style={{ marginBottom: 24 }}>
        <Row gutter={16}>
          <Col span={6}>
            <Statistic
              title="Total Participants"
              value={totalParticipants}
            />
          </Col>
          {Object.entries(stateCounts).map(([state, count]) => (
            <Col span={6} key={state}>
              <Statistic
                title={
                  <span>
                    {state} <Tag color={stateColors[state] || 'default'} />
                  </span>
                }
                value={count}
              />
            </Col>
          ))}
        </Row>
      </Card>

      <Card title="State Breakdown by Form">
        <Table
          columns={columns}
          dataSource={summary}
          rowKey={(record) => `${record.current_form}-${record.current_state}`}
          pagination={{ pageSize: 20 }}
        />
      </Card>
    </div>
  );
};

StatesSummary.propTypes = {
  surveyName: PropTypes.string.isRequired,
};

export default StatesSummary;
