import React, { useState, useEffect } from 'react';
import PropTypes from 'prop-types';
import { useParams, useHistory } from 'react-router-dom';
import {
  Form, Input, Select, Button, Switch, Card, Space,
  TimePicker, DatePicker, Spin, message, Alert
} from 'antd';
import { SaveOutlined, EyeOutlined, ArrowLeftOutlined } from '@ant-design/icons';
import moment from 'moment';
import api from '../../services/api';
import ConditionBuilder from '../../components/ConditionBuilder';
import { Loading } from '../../components/UI';

const { Option } = Select;
const { TextArea } = Input;

const BailForm = ({ surveyId, backPath }) => {
  const { bailId } = useParams();
  const history = useHistory();
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(!!bailId);
  const [saving, setSaving] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [previewResult, setPreviewResult] = useState(null);
  const [timing, setTiming] = useState('immediate');

  const isEdit = !!bailId;

  useEffect(() => {
    if (isEdit) {
      loadBail();
    }
  }, [surveyId, bailId]);

  const loadBail = async () => {
    try {
      const res = await api.fetcher({ path: `/surveys/${surveyId}/bails/${bailId}` });
      const data = await res.json();
      const bail = data.bail;
      const def = bail.definition;

      // Set timing state for conditional field rendering
      setTiming(def.execution?.timing || 'immediate');

      // Populate form
      form.setFieldsValue({
        name: bail.name,
        description: bail.description,
        enabled: bail.enabled,
        conditions: def.conditions,
        timing: def.execution?.timing || 'immediate',
        time_of_day: def.execution?.time_of_day ? moment(def.execution.time_of_day, 'HH:mm') : null,
        timezone: def.execution?.timezone || 'UTC',
        datetime: def.execution?.datetime ? moment(def.execution.datetime) : null,
        destination_form: def.action?.destination_form,
        metadata: def.action?.metadata ? JSON.stringify(def.action.metadata, null, 2) : '',
      });
    } catch (err) {
      message.error('Failed to load bail');
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const buildDefinition = (values) => {
    const execution = {
      timing: values.timing,
    };

    if (values.timing === 'scheduled') {
      if (values.time_of_day) {
        execution.time_of_day = values.time_of_day.format('HH:mm');
      }
      execution.timezone = values.timezone || 'UTC';
    } else if (values.timing === 'absolute') {
      if (values.datetime) {
        execution.datetime = values.datetime.toISOString();
      }
    }

    let metadata = {};
    if (values.metadata) {
      try {
        metadata = JSON.parse(values.metadata);
      } catch (e) {
        // Invalid JSON, use empty object
      }
    }

    return {
      conditions: values.conditions,
      execution,
      action: {
        destination_form: values.destination_form,
        metadata,
      },
    };
  };

  const onFinish = async (values) => {
    setSaving(true);
    try {
      const definition = buildDefinition(values);
      const body = {
        name: values.name,
        description: values.description,
        definition,
        enabled: values.enabled ?? false,
      };

      if (isEdit) {
        await api.fetcher({
          path: `/surveys/${surveyId}/bails/${bailId}`,
          method: 'PUT',
          body,
        });
        message.success('Bail updated successfully');
      } else {
        await api.fetcher({
          path: `/surveys/${surveyId}/bails`,
          method: 'POST',
          body,
        });
        message.success('Bail created successfully');
      }
      history.push(backPath);
    } catch (err) {
      message.error(`Failed to ${isEdit ? 'update' : 'create'} bail: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  const handlePreview = async () => {
    setPreviewing(true);
    setPreviewResult(null);
    try {
      const values = form.getFieldsValue();
      const definition = buildDefinition(values);

      const res = await api.fetcher({
        path: `/surveys/${surveyId}/bails/preview`,
        method: 'POST',
        body: { definition },
      });
      const result = await res.json();
      setPreviewResult(result);
    } catch (err) {
      message.error(`Preview failed: ${err.message}`);
    } finally {
      setPreviewing(false);
    }
  };

  if (loading) return <Loading>Loading...</Loading>;

  return (
    <div style={{ padding: '30px', maxWidth: 900 }}>
      <Button
        icon={<ArrowLeftOutlined />}
        onClick={() => history.push(backPath)}
        style={{ marginBottom: 16 }}
      >
        Back to Bail Systems
      </Button>

      <h2>{isEdit ? 'Edit' : 'Create'} Bail System</h2>

      <Spin spinning={saving}>
        <Form
          form={form}
          layout="vertical"
          onFinish={onFinish}
          initialValues={{
            enabled: false,
            timing: 'immediate',
            timezone: 'UTC',
            conditions: { type: 'form', value: '' },
          }}
        >
          {/* Basic Info */}
          <Card title="Basic Information" style={{ marginBottom: 16 }}>
            <Form.Item
              name="name"
              label="Name"
              rules={[{ required: true, message: 'Please enter a name' }]}
            >
              <Input placeholder="e.g., 4-week dropout recovery" />
            </Form.Item>

            <Form.Item name="description" label="Description">
              <TextArea rows={2} placeholder="Describe what this bail system does..." />
            </Form.Item>

            <Form.Item name="enabled" label="Enabled" valuePropName="checked">
              <Switch />
            </Form.Item>
          </Card>

          {/* Conditions */}
          <Card title="Conditions" style={{ marginBottom: 16 }}>
            <p style={{ color: '#666', marginBottom: 16 }}>
              Define which users should be bailed. You can combine multiple conditions using AND/OR logic.
            </p>
            <Form.Item
              name="conditions"
              rules={[{ required: true, message: 'Please define at least one condition' }]}
            >
              <ConditionBuilder />
            </Form.Item>
          </Card>

          {/* Execution Timing */}
          <Card title="Execution Timing" style={{ marginBottom: 16 }}>
            <Form.Item
              name="timing"
              label="Timing Mode"
              rules={[{ required: true }]}
            >
              <Select onChange={setTiming}>
                <Option value="immediate">Immediate (every execution cycle)</Option>
                <Option value="scheduled">Scheduled (daily at specific time)</Option>
                <Option value="absolute">Absolute (one-time at specific datetime)</Option>
              </Select>
            </Form.Item>

            {timing === 'scheduled' && (
              <>
                <Form.Item
                  name="time_of_day"
                  label="Time of Day"
                  rules={[{ required: true, message: 'Please select a time' }]}
                >
                  <TimePicker format="HH:mm" />
                </Form.Item>

                <Form.Item
                  name="timezone"
                  label="Timezone"
                  rules={[{ required: true }]}
                >
                  <Select showSearch>
                    <Option value="UTC">UTC</Option>
                    <Option value="America/New_York">America/New_York</Option>
                    <Option value="America/Los_Angeles">America/Los_Angeles</Option>
                    <Option value="America/Chicago">America/Chicago</Option>
                    <Option value="Europe/London">Europe/London</Option>
                    <Option value="Europe/Paris">Europe/Paris</Option>
                    <Option value="Asia/Tokyo">Asia/Tokyo</Option>
                    <Option value="Asia/Shanghai">Asia/Shanghai</Option>
                    <Option value="Asia/Kolkata">Asia/Kolkata</Option>
                    <Option value="Australia/Sydney">Australia/Sydney</Option>
                  </Select>
                </Form.Item>
              </>
            )}

            {timing === 'absolute' && (
              <Form.Item
                name="datetime"
                label="Execute At"
                rules={[{ required: true, message: 'Please select a datetime' }]}
              >
                <DatePicker showTime format="YYYY-MM-DD HH:mm" />
              </Form.Item>
            )}
          </Card>

          {/* Action */}
          <Card title="Action" style={{ marginBottom: 16 }}>
            <Form.Item
              name="destination_form"
              label="Destination Form"
              rules={[{ required: true, message: 'Please enter the destination form' }]}
              extra="The form/survey shortcode to redirect bailed users to"
            >
              <Input placeholder="e.g., exit_survey_v2" />
            </Form.Item>

            <Form.Item
              name="metadata"
              label="Metadata (JSON)"
              extra="Optional JSON metadata to include with the bail event"
            >
              <TextArea
                rows={3}
                placeholder='{"reason": "dropout_4weeks", "version": 1}'
              />
            </Form.Item>
          </Card>

          {/* Preview */}
          <Card title="Preview" style={{ marginBottom: 16 }}>
            <p style={{ color: '#666', marginBottom: 16 }}>
              Preview which users would be bailed with the current conditions (dry run).
            </p>
            <Button
              icon={<EyeOutlined />}
              onClick={handlePreview}
              loading={previewing}
            >
              Preview Matching Users
            </Button>

            {previewResult && (
              <Alert
                style={{ marginTop: 16 }}
                type={previewResult.count > 0 ? 'info' : 'warning'}
                message={`${previewResult.count} users would be bailed`}
                description={
                  previewResult.count > 0 ? (
                    <div>
                      <p>Sample users:</p>
                      <ul>
                        {previewResult.users.slice(0, 5).map((u, i) => (
                          <li key={i}>{u.userid} (page: {u.pageid})</li>
                        ))}
                        {previewResult.count > 5 && <li>... and {previewResult.count - 5} more</li>}
                      </ul>
                    </div>
                  ) : 'No users match the current conditions.'
                }
              />
            )}
          </Card>

          {/* Submit */}
          <Space>
            <Button
              type="primary"
              htmlType="submit"
              icon={<SaveOutlined />}
              loading={saving}
              size="large"
            >
              {isEdit ? 'Update' : 'Create'} Bail System
            </Button>
            <Button onClick={() => history.push(backPath)}>
              Cancel
            </Button>
          </Space>
        </Form>
      </Spin>
    </div>
  );
};

BailForm.propTypes = {
  surveyId: PropTypes.string.isRequired,
  backPath: PropTypes.string.isRequired,
};

export default BailForm;
