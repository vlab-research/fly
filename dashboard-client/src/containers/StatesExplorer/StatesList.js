import React, { useState, useEffect } from 'react';
import PropTypes from 'prop-types';
import { useHistory, useLocation, Link } from 'react-router-dom';
import { Card, Table, Tag, Input, Select, Button, Row, Col, message } from 'antd';
import { SearchOutlined, ReloadOutlined } from '@ant-design/icons';
import api from '../../services/api';

const { Option } = Select;

const VALID_STATES = new Set([
  'START', 'RESPONDING', 'QOUT', 'END',
  'BLOCKED', 'ERROR', 'WAIT_EXTERNAL_EVENT', 'USER_BLOCKED',
]);

const StatesList = ({ surveyName }) => {
  const history = useHistory();
  const location = useLocation();
  const [states, setStates] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  // Read initial filters from URL query params (for drill-down from Summary)
  const getInitialFilters = () => {
    const params = new URLSearchParams(location.search);
    const stateParam = params.get('state');
    return {
      state: (stateParam && VALID_STATES.has(stateParam)) ? stateParam : null,
      error_tag: params.get('error_tag') || '',
      search: params.get('search') || '',
    };
  };

  const [filters, setFilters] = useState(getInitialFilters);

  // Pagination state
  const [pagination, setPagination] = useState({
    current: 1,
    pageSize: 50,
  });

  useEffect(() => {
    loadStates();
  }, [surveyName, filters, pagination.current, pagination.pageSize]);

  const loadStates = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();

      // Add filters if present
      if (filters.state) params.append('state', filters.state);
      if (filters.error_tag) params.append('error_tag', filters.error_tag);
      if (filters.search) params.append('search', filters.search);

      // Add pagination
      params.append('limit', pagination.pageSize);
      params.append('offset', (pagination.current - 1) * pagination.pageSize);

      const res = await api.fetcher({
        path: `/surveys/${encodeURIComponent(surveyName)}/states?${params.toString()}`
      });
      const data = await res.json();

      setStates(data.states || []);
      setTotal(data.total || 0);
    } catch (err) {
      message.error('Failed to load states list');
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const handleFilterChange = (key, value) => {
    setFilters(prev => ({ ...prev, [key]: value }));
    setPagination(prev => ({ ...prev, current: 1 })); // Reset to first page on filter change
  };

  const handleTableChange = (paginationConfig) => {
    setPagination({
      current: paginationConfig.current,
      pageSize: paginationConfig.pageSize,
    });
  };

  const handleReset = () => {
    setFilters({
      state: null,
      error_tag: '',
      search: '',
    });
    setPagination({
      current: 1,
      pageSize: 50,
    });
    // Clear URL query params so they don't persist after reset
    history.replace(location.pathname);
  };

  const handleRowClick = (record) => {
    history.push(`/surveys/${encodeURIComponent(surveyName)}/monitor/${encodeURIComponent(record.userid)}`);
  };

  // State color mapping
  const stateColors = {
    START: 'blue',
    RESPONDING: 'green',
    QOUT: 'cyan',
    END: 'default',
    BLOCKED: 'red',
    ERROR: 'red',
    WAIT_EXTERNAL_EVENT: 'orange',
    USER_BLOCKED: 'volcano',
  };

  const columns = [
    {
      title: 'User ID',
      dataIndex: 'userid',
      key: 'userid',
      width: 200,
      render: (userid) => (
        <Link
          to={`/surveys/${encodeURIComponent(surveyName)}/monitor/${encodeURIComponent(userid)}`}
          onClick={(e) => e.stopPropagation()}
        >
          {userid}
        </Link>
      ),
    },
    {
      title: 'State',
      dataIndex: 'current_state',
      key: 'current_state',
      width: 150,
      render: (state) => (
        <Tag color={stateColors[state] || 'default'}>
          {state}
        </Tag>
      ),
    },
    {
      title: 'Form',
      dataIndex: 'current_form',
      key: 'current_form',
      width: 150,
    },
    {
      title: 'Last Updated',
      dataIndex: 'updated',
      key: 'updated',
      width: 180,
      render: (updated) => updated ? new Date(updated).toLocaleString() : 'N/A',
    },
    {
      title: 'Error Tag',
      dataIndex: 'error_tag',
      key: 'error_tag',
      width: 150,
      render: (errorTag) => errorTag ? (
        <Tag color="red">{errorTag}</Tag>
      ) : '-',
    },
    {
      title: 'Stuck on Question',
      dataIndex: 'stuck_on_question',
      key: 'stuck_on_question',
      width: 150,
      align: 'center',
      render: (stuck) => {
        if (stuck === true) return <Tag color="orange">Yes</Tag>;
        if (stuck === false) return <Tag color="green">No</Tag>;
        return '-';
      },
    },
    {
      title: 'Timeout Date',
      dataIndex: 'timeout_date',
      key: 'timeout_date',
      width: 180,
      render: (timeoutDate) => timeoutDate ? new Date(timeoutDate).toLocaleString() : '-',
    },
  ];

  return (
    <div>
      <Card style={{ marginBottom: 16 }}>
        <Row gutter={[16, 16]}>
          <Col xs={24} sm={12} md={6}>
            <div style={{ marginBottom: 8, fontWeight: 500 }}>State</div>
            <Select
              allowClear
              placeholder="Filter by state"
              style={{ width: '100%' }}
              value={filters.state}
              onChange={(value) => handleFilterChange('state', value)}
            >
              <Option value="START">START</Option>
              <Option value="RESPONDING">RESPONDING</Option>
              <Option value="QOUT">QOUT</Option>
              <Option value="END">END</Option>
              <Option value="BLOCKED">BLOCKED</Option>
              <Option value="ERROR">ERROR</Option>
              <Option value="WAIT_EXTERNAL_EVENT">WAIT_EXTERNAL_EVENT</Option>
              <Option value="USER_BLOCKED">USER_BLOCKED</Option>
            </Select>
          </Col>

          <Col xs={24} sm={12} md={6}>
            <div style={{ marginBottom: 8, fontWeight: 500 }}>Error Tag</div>
            <Input
              allowClear
              placeholder="Filter by error tag"
              value={filters.error_tag}
              onChange={(e) => handleFilterChange('error_tag', e.target.value)}
              prefix={<SearchOutlined />}
            />
          </Col>

          <Col xs={24} sm={12} md={6}>
            <div style={{ marginBottom: 8, fontWeight: 500 }}>User ID</div>
            <Input
              allowClear
              placeholder="Search by user ID"
              value={filters.search}
              onChange={(e) => handleFilterChange('search', e.target.value)}
              prefix={<SearchOutlined />}
            />
          </Col>

          <Col xs={24} sm={12} md={6}>
            <div style={{ marginBottom: 8, fontWeight: 500 }}>&nbsp;</div>
            <Button
              icon={<ReloadOutlined />}
              onClick={handleReset}
              style={{ width: '100%' }}
            >
              Reset Filters
            </Button>
          </Col>
        </Row>
      </Card>

      <Card title={`Participant States (${total} total)`}>
        <Table
          columns={columns}
          dataSource={states}
          rowKey="userid"
          loading={loading}
          pagination={{
            current: pagination.current,
            pageSize: pagination.pageSize,
            total: total,
            showSizeChanger: true,
            showTotal: (total, range) => `${range[0]}-${range[1]} of ${total} participants`,
            pageSizeOptions: ['10', '20', '50', '100'],
          }}
          onChange={handleTableChange}
          onRow={(record) => ({
            onClick: () => handleRowClick(record),
            style: { cursor: 'pointer' },
          })}
          scroll={{ x: 1200 }}
        />
      </Card>
    </div>
  );
};

StatesList.propTypes = {
  surveyName: PropTypes.string.isRequired,
};

export default StatesList;
