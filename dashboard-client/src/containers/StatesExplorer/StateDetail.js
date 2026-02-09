import React, { useState, useEffect } from 'react';
import PropTypes from 'prop-types';
import { useParams, useHistory } from 'react-router-dom';
import {
  Layout,
  Card,
  Descriptions,
  Table,
  Tag,
  Alert,
  Collapse,
  Button,
  message,
} from 'antd';
import { ArrowLeftOutlined } from '@ant-design/icons';
import api from '../../services/api';
import { Loading } from '../../components/UI';

const { Content } = Layout;
const { Panel } = Collapse;

const StateDetail = ({ surveyName, backPath }) => {
  const { userid } = useParams();
  const history = useHistory();
  const [state, setState] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadStateDetail();
  }, [surveyName, userid]);

  const loadStateDetail = async () => {
    try {
      const res = await api.fetcher({
        path: `/surveys/${encodeURIComponent(surveyName)}/states/${encodeURIComponent(userid)}`,
      });
      const data = await res.json();
      setState(data);
    } catch (err) {
      message.error('Failed to load state details');
      console.error('Failed to load state details:', err);
    } finally {
      setLoading(false);
    }
  };

  if (loading) return <Loading>Loading state details...</Loading>;

  if (!state) {
    return (
      <Layout>
        <Content style={{ padding: '30px' }}>
          <Alert
            message="State Not Found"
            description="No state found for this user."
            type="error"
            showIcon
          />
        </Content>
      </Layout>
    );
  }

  // Parse state_json
  const stateJson = state.state_json || {};
  const currentState = state.current_state;
  const isError = currentState === 'ERROR';
  const isWaiting = currentState === 'WAIT_EXTERNAL_EVENT';

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

  // QA transcript columns
  const qaColumns = [
    {
      title: '#',
      key: 'index',
      width: 60,
      render: (_, __, index) => index + 1,
    },
    {
      title: 'Question',
      dataIndex: 'question',
      key: 'question',
      render: (question) => {
        if (!question) return '-';
        return (
          <div>
            <div><strong>{question.ref || 'N/A'}</strong></div>
            <div style={{ fontSize: '0.9em', color: '#666' }}>
              {question.text || 'N/A'}
            </div>
          </div>
        );
      },
    },
    {
      title: 'Answer',
      dataIndex: 'response',
      key: 'response',
      render: (response) => {
        if (!response) return '-';
        return (
          <div>
            <div>{response.text || 'N/A'}</div>
            {response.value !== undefined && (
              <div style={{ fontSize: '0.9em', color: '#666' }}>
                Value: {JSON.stringify(response.value)}
              </div>
            )}
          </div>
        );
      },
    },
  ];

  return (
    <Layout>
      <Content style={{ padding: '30px' }}>
        <Button
          icon={<ArrowLeftOutlined />}
          onClick={() => history.push(backPath)}
          style={{ marginBottom: 16 }}
        >
          Back to States List
        </Button>

        <Card title={`State Details: ${userid}`} style={{ marginBottom: 16 }}>
          <Descriptions bordered column={2}>
            <Descriptions.Item label="User ID" span={2}>
              {state.userid}
            </Descriptions.Item>
            <Descriptions.Item label="Page ID" span={2}>
              {state.pageid}
            </Descriptions.Item>
            <Descriptions.Item label="Current State">
              <Tag color={stateColors[currentState] || 'default'}>
                {currentState}
              </Tag>
            </Descriptions.Item>
            <Descriptions.Item label="Current Form">
              {state.current_form || 'N/A'}
            </Descriptions.Item>
            <Descriptions.Item label="Last Updated">
              {state.updated ? new Date(state.updated).toLocaleString() : 'N/A'}
            </Descriptions.Item>
            <Descriptions.Item label="Form Start Time">
              {state.form_start_time
                ? new Date(state.form_start_time).toLocaleString()
                : 'N/A'}
            </Descriptions.Item>
            {state.error_tag && (
              <Descriptions.Item label="Error Tag" span={2}>
                <Tag color="red">{state.error_tag}</Tag>
              </Descriptions.Item>
            )}
            {state.fb_error_code && (
              <Descriptions.Item label="FB Error Code">
                {state.fb_error_code}
              </Descriptions.Item>
            )}
            {state.stuck_on_question !== undefined && (
              <Descriptions.Item label="Stuck on Question">
                {state.stuck_on_question ? (
                  <Tag color="orange">Yes</Tag>
                ) : (
                  <Tag color="green">No</Tag>
                )}
              </Descriptions.Item>
            )}
            {state.timeout_date && (
              <Descriptions.Item label="Timeout Date">
                {new Date(state.timeout_date).toLocaleString()}
              </Descriptions.Item>
            )}
          </Descriptions>
        </Card>

        {/* Error Details Card - shown if in ERROR state */}
        {isError && stateJson.error && (
          <Card
            title="Error Details"
            style={{ marginBottom: 16 }}
            headStyle={{ backgroundColor: '#fff1f0' }}
          >
            <Descriptions bordered column={1}>
              {stateJson.error.tag && (
                <Descriptions.Item label="Error Tag">
                  <Tag color="red">{stateJson.error.tag}</Tag>
                </Descriptions.Item>
              )}
              {stateJson.error.message && (
                <Descriptions.Item label="Message">
                  {stateJson.error.message}
                </Descriptions.Item>
              )}
              {stateJson.error.fb_error_code && (
                <Descriptions.Item label="Facebook Error Code">
                  {stateJson.error.fb_error_code}
                </Descriptions.Item>
              )}
              {stateJson.error.payment_error_code && (
                <Descriptions.Item label="Payment Error Code">
                  {stateJson.error.payment_error_code}
                </Descriptions.Item>
              )}
              {stateJson.error.details && (
                <Descriptions.Item label="Details">
                  <pre style={{ margin: 0, whiteSpace: 'pre-wrap' }}>
                    {JSON.stringify(stateJson.error.details, null, 2)}
                  </pre>
                </Descriptions.Item>
              )}
            </Descriptions>
          </Card>
        )}

        {/* Wait Condition Card - shown if WAITING */}
        {isWaiting && stateJson.wait && (
          <Card
            title="Wait Condition"
            style={{ marginBottom: 16 }}
            headStyle={{ backgroundColor: '#fffbe6' }}
          >
            <Descriptions bordered column={1}>
              {stateJson.wait.event && (
                <Descriptions.Item label="Expected Event">
                  {stateJson.wait.event}
                </Descriptions.Item>
              )}
              {stateJson.wait.timeout && (
                <Descriptions.Item label="Timeout">
                  {new Date(stateJson.wait.timeout).toLocaleString()}
                </Descriptions.Item>
              )}
              {stateJson.wait.reason && (
                <Descriptions.Item label="Reason">
                  {stateJson.wait.reason}
                </Descriptions.Item>
              )}
              {stateJson.wait.metadata && (
                <Descriptions.Item label="Metadata">
                  <pre style={{ margin: 0, whiteSpace: 'pre-wrap' }}>
                    {JSON.stringify(stateJson.wait.metadata, null, 2)}
                  </pre>
                </Descriptions.Item>
              )}
            </Descriptions>
          </Card>
        )}

        {/* QA Transcript */}
        {stateJson.qa && stateJson.qa.length > 0 && (
          <Card title="Question & Answer Transcript" style={{ marginBottom: 16 }}>
            <Table
              columns={qaColumns}
              dataSource={stateJson.qa}
              rowKey={(record, index) => index}
              pagination={{ pageSize: 20 }}
              size="small"
            />
          </Card>
        )}

        {/* Collapsible Raw State JSON */}
        <Collapse>
          <Panel header="Raw State JSON" key="raw-state">
            <pre
              style={{
                maxHeight: '500px',
                overflow: 'auto',
                backgroundColor: '#f5f5f5',
                padding: '16px',
                borderRadius: '4px',
              }}
            >
              {JSON.stringify(stateJson, null, 2)}
            </pre>
          </Panel>
        </Collapse>
      </Content>
    </Layout>
  );
};

StateDetail.propTypes = {
  surveyName: PropTypes.string.isRequired,
  backPath: PropTypes.string.isRequired,
};

export default StateDetail;
