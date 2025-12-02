# Exodus UI Implementation Plan

## Overview

This plan covers adding bail management to the vlab dashboard, consisting of:
1. **Dashboard-Server** - Proxy layer that forwards requests to the Exodus API
2. **Dashboard-Client** - React/AntD UI for managing bail definitions

The UI will allow users to create, edit, preview, and monitor bail systems for their surveys.

---

## Part 1: Dashboard-Server (Proxy Layer)

### 1.1 Architecture

The dashboard-server acts as a proxy between the authenticated dashboard-client and the exodus API. This maintains the existing security model where the client only talks to dashboard-server.

```
Dashboard-Client (React)
    ↓ (Auth0 JWT)
Dashboard-Server (Express)
    ↓ (Internal HTTP)
Exodus API (Go)
    ↓
CockroachDB
```

### 1.2 New Files to Create

```
dashboard-server/
├── api/
│   └── bails/
│       ├── index.js              # Module export
│       ├── bails.routes.js       # Route definitions
│       └── bails.controller.js   # Request handlers
├── utils/
│   └── bails/
│       ├── index.js              # Module export
│       └── bails.util.js         # HTTP client for Exodus API
└── config/
    └── index.js                  # Add EXODUS_API_URL config
```

### 1.3 Configuration

**File:** `config/index.js`

Add new environment variable:
```javascript
EXODUS: {
  url: process.env.EXODUS_API_URL || 'http://exodus-api:8080',
}
```

### 1.4 Utility Layer

**File:** `utils/bails/bails.util.js`

```javascript
const r2 = require('r2');
const Config = require('../../config');

const baseUrl = Config.EXODUS.url;

// Helper for making authenticated requests to Exodus API
async function exodusRequest(method, path, body = null) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };

  if (body) {
    opts.body = JSON.stringify(body);
  }

  const res = await r2(`${baseUrl}${path}`, opts).response;

  if (!res.ok) {
    const error = await res.json().catch(() => ({ message: res.statusText }));
    const err = new Error(error.message || `Exodus API error: ${res.status}`);
    err.status = res.status;
    throw err;
  }

  // Handle 204 No Content
  if (res.status === 204) {
    return null;
  }

  return res.json();
}

// Bail CRUD operations
async function listBails(surveyId) {
  return exodusRequest('GET', `/surveys/${surveyId}/bails`);
}

async function getBail(surveyId, bailId) {
  return exodusRequest('GET', `/surveys/${surveyId}/bails/${bailId}`);
}

async function createBail(surveyId, bail) {
  return exodusRequest('POST', `/surveys/${surveyId}/bails`, bail);
}

async function updateBail(surveyId, bailId, bail) {
  return exodusRequest('PUT', `/surveys/${surveyId}/bails/${bailId}`, bail);
}

async function deleteBail(surveyId, bailId) {
  return exodusRequest('DELETE', `/surveys/${surveyId}/bails/${bailId}`);
}

// Preview (dry-run)
async function previewBail(surveyId, definition) {
  return exodusRequest('POST', `/surveys/${surveyId}/bails/preview`, { definition });
}

// Events
async function getBailEvents(surveyId, bailId) {
  return exodusRequest('GET', `/surveys/${surveyId}/bails/${bailId}/events`);
}

async function getSurveyEvents(surveyId, limit = 100) {
  return exodusRequest('GET', `/surveys/${surveyId}/bail-events?limit=${limit}`);
}

module.exports = {
  listBails,
  getBail,
  createBail,
  updateBail,
  deleteBail,
  previewBail,
  getBailEvents,
  getSurveyEvents,
};
```

### 1.5 Controller Layer

**File:** `api/bails/bails.controller.js`

```javascript
const BailsUtil = require('../../utils/bails');
const { User, Survey } = require('../../queries');

function handle(err, res) {
  console.error('Bails API Error:', err);
  const status = err.status || 500;
  res.status(status).json({ error: { message: err.message } });
}

// Middleware to validate survey ownership
async function validateSurveyAccess(req, res, next) {
  try {
    const { email } = req.user;
    const { surveyId } = req.params;

    if (!email) {
      return res.status(401).json({ error: { message: 'Authentication required' } });
    }

    // Verify user owns this survey
    const user = await User.user({ email });
    if (!user) {
      return res.status(404).json({ error: { message: 'User not found' } });
    }

    const surveys = await Survey.retrieve({ email });
    const survey = surveys.find(s => s.id === surveyId);

    if (!survey) {
      return res.status(403).json({ error: { message: 'Access denied to this survey' } });
    }

    req.survey = survey;
    next();
  } catch (err) {
    handle(err, res);
  }
}

// List all bails for a survey
exports.listBails = async (req, res) => {
  try {
    const { surveyId } = req.params;
    const result = await BailsUtil.listBails(surveyId);
    res.status(200).json(result);
  } catch (err) {
    handle(err, res);
  }
};

// Get a single bail
exports.getBail = async (req, res) => {
  try {
    const { surveyId, bailId } = req.params;
    const result = await BailsUtil.getBail(surveyId, bailId);
    res.status(200).json(result);
  } catch (err) {
    handle(err, res);
  }
};

// Create a new bail
exports.createBail = async (req, res) => {
  try {
    const { surveyId } = req.params;
    const { name, description, definition } = req.body;

    if (!name || !definition) {
      return res.status(400).json({ error: { message: 'name and definition are required' } });
    }

    const result = await BailsUtil.createBail(surveyId, { name, description, definition });
    res.status(201).json(result);
  } catch (err) {
    handle(err, res);
  }
};

// Update an existing bail
exports.updateBail = async (req, res) => {
  try {
    const { surveyId, bailId } = req.params;
    const { name, description, definition, enabled } = req.body;

    const result = await BailsUtil.updateBail(surveyId, bailId, {
      name,
      description,
      definition,
      enabled,
    });
    res.status(200).json(result);
  } catch (err) {
    handle(err, res);
  }
};

// Delete a bail
exports.deleteBail = async (req, res) => {
  try {
    const { surveyId, bailId } = req.params;
    await BailsUtil.deleteBail(surveyId, bailId);
    res.status(204).send();
  } catch (err) {
    handle(err, res);
  }
};

// Preview bail (dry-run query)
exports.previewBail = async (req, res) => {
  try {
    const { surveyId } = req.params;
    const { definition } = req.body;

    if (!definition) {
      return res.status(400).json({ error: { message: 'definition is required' } });
    }

    const result = await BailsUtil.previewBail(surveyId, definition);
    res.status(200).json(result);
  } catch (err) {
    handle(err, res);
  }
};

// Get events for a specific bail
exports.getBailEvents = async (req, res) => {
  try {
    const { surveyId, bailId } = req.params;
    const result = await BailsUtil.getBailEvents(surveyId, bailId);
    res.status(200).json(result);
  } catch (err) {
    handle(err, res);
  }
};

// Get all events for a survey
exports.getSurveyEvents = async (req, res) => {
  try {
    const { surveyId } = req.params;
    const { limit } = req.query;
    const result = await BailsUtil.getSurveyEvents(surveyId, limit ? parseInt(limit) : 100);
    res.status(200).json(result);
  } catch (err) {
    handle(err, res);
  }
};

exports.validateSurveyAccess = validateSurveyAccess;
```

### 1.6 Routes Layer

**File:** `api/bails/bails.routes.js`

```javascript
const router = require('express').Router({ mergeParams: true });
const controller = require('./bails.controller');

// All routes are prefixed with /surveys/:surveyId/bails
// Survey access is validated by middleware

router.use(controller.validateSurveyAccess);

router
  .get('/', controller.listBails)
  .post('/', controller.createBail)
  .post('/preview', controller.previewBail)
  .get('/:bailId', controller.getBail)
  .put('/:bailId', controller.updateBail)
  .delete('/:bailId', controller.deleteBail)
  .get('/:bailId/events', controller.getBailEvents);

module.exports = router;
```

**File:** `api/bails/index.js`

```javascript
module.exports = require('./bails.routes');
```

### 1.7 Mount Routes

**File:** `api/index.js` (modify)

Add to existing router:
```javascript
router
  .use('/responses', require('./responses'))
  // ... existing routes ...
  .use('/surveys/:surveyId/bails', require('./bails'));  // NEW
```

Also add a survey-level events endpoint:
```javascript
// In api/surveys/survey.routes.js
router.get('/:surveyId/bail-events', bailsController.getSurveyEvents);
```

---

## Part 2: Dashboard-Client (React UI)

### 2.1 Architecture Overview

The UI consists of:
1. **BailSystems** - Main container with list view and routing
2. **BailForm** - Create/Edit form with condition builder
3. **BailEvents** - Event history view
4. **ConditionBuilder** - Complex nested condition editor

### 2.2 New Files to Create

```
dashboard-client/src/
├── containers/
│   └── BailSystems/
│       ├── index.js                    # Export
│       ├── BailSystems.js              # Main list view
│       ├── BailForm.js                 # Create/Edit form
│       ├── BailEvents.js               # Event history
│       └── BailSystems.css             # Styles
├── components/
│   └── ConditionBuilder/
│       ├── index.js                    # Export
│       ├── ConditionBuilder.js         # Main builder component
│       ├── SimpleCondition.js          # Single condition editor
│       ├── CompoundCondition.js        # AND/OR container
│       └── style.js                    # Styled components
└── services/
    └── api/
        └── bails.js                    # API helper functions (optional)
```

### 2.3 Routing Setup

**File:** `root.js` (modify)

Add new routes under the survey context:
```javascript
import { BailSystems, BailForm, BailEvents } from './containers';

// Inside Routes
<PrivateRoute
  path="/surveys/:surveyId/bails"
  component={BailSystems}
  auth={Auth}
/>
<PrivateRoute
  path="/surveys/:surveyId/bails/create"
  component={BailForm}
  auth={Auth}
/>
<PrivateRoute
  path="/surveys/:surveyId/bails/:bailId/edit"
  component={BailForm}
  auth={Auth}
/>
<PrivateRoute
  path="/surveys/:surveyId/bails/:bailId/events"
  component={BailEvents}
  auth={Auth}
/>
```

### 2.4 Main List View

**File:** `containers/BailSystems/BailSystems.js`

```javascript
import React, { useState, useEffect } from 'react';
import { Link, useParams, useHistory } from 'react-router-dom';
import { Table, Layout, Switch, Tag, Space, Button, Popconfirm, message } from 'antd';
import { PlusOutlined, EditOutlined, DeleteOutlined, HistoryOutlined } from '@ant-design/icons';
import api from '../../services/api';
import { Loading, CreateBtn } from '../../components/UI';
import './BailSystems.css';

const { Content } = Layout;

const BailSystems = () => {
  const { surveyId } = useParams();
  const history = useHistory();
  const [bails, setBails] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadBails();
  }, [surveyId]);

  const loadBails = async () => {
    try {
      const res = await api.fetcher({ path: `/surveys/${surveyId}/bails` });
      const data = await res.json();
      setBails(data.bails || []);
    } catch (err) {
      message.error('Failed to load bail systems');
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const handleToggleEnabled = async (bail, enabled) => {
    try {
      await api.fetcher({
        path: `/surveys/${surveyId}/bails/${bail.bail.id}`,
        method: 'PUT',
        body: { enabled },
      });
      setBails(bails.map(b =>
        b.bail.id === bail.bail.id
          ? { ...b, bail: { ...b.bail, enabled } }
          : b
      ));
      message.success(`Bail ${enabled ? 'enabled' : 'disabled'}`);
    } catch (err) {
      message.error('Failed to update bail');
    }
  };

  const handleDelete = async (bailId) => {
    try {
      await api.fetcher({
        path: `/surveys/${surveyId}/bails/${bailId}`,
        method: 'DELETE',
        raw: true,
      });
      setBails(bails.filter(b => b.bail.id !== bailId));
      message.success('Bail deleted');
    } catch (err) {
      message.error('Failed to delete bail');
    }
  };

  const columns = [
    {
      title: 'Name',
      dataIndex: ['bail', 'name'],
      key: 'name',
      render: (text, record) => (
        <Link to={`/surveys/${surveyId}/bails/${record.bail.id}/edit`}>
          {text}
        </Link>
      ),
    },
    {
      title: 'Enabled',
      dataIndex: ['bail', 'enabled'],
      key: 'enabled',
      render: (enabled, record) => (
        <Switch
          checked={enabled}
          onChange={(checked) => handleToggleEnabled(record, checked)}
        />
      ),
    },
    {
      title: 'Timing',
      dataIndex: ['bail', 'definition', 'execution', 'timing'],
      key: 'timing',
      render: (timing) => (
        <Tag color={timing === 'immediate' ? 'green' : timing === 'scheduled' ? 'blue' : 'orange'}>
          {timing}
        </Tag>
      ),
    },
    {
      title: 'Destination',
      dataIndex: ['bail', 'destination_form'],
      key: 'destination',
    },
    {
      title: 'Last Execution',
      dataIndex: 'last_event',
      key: 'last_event',
      render: (event) => {
        if (!event) return <span style={{ color: '#999' }}>Never</span>;
        return (
          <span>
            {new Date(event.timestamp).toLocaleString()}
            <br />
            <small>
              {event.users_matched} matched, {event.users_bailed} bailed
            </small>
          </span>
        );
      },
    },
    {
      title: 'Actions',
      key: 'actions',
      render: (_, record) => (
        <Space>
          <Button
            icon={<EditOutlined />}
            size="small"
            onClick={() => history.push(`/surveys/${surveyId}/bails/${record.bail.id}/edit`)}
          />
          <Button
            icon={<HistoryOutlined />}
            size="small"
            onClick={() => history.push(`/surveys/${surveyId}/bails/${record.bail.id}/events`)}
          />
          <Popconfirm
            title="Delete this bail system?"
            onConfirm={() => handleDelete(record.bail.id)}
            okText="Yes"
            cancelText="No"
          >
            <Button icon={<DeleteOutlined />} size="small" danger />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  if (loading) return <Loading>Loading bail systems...</Loading>;

  return (
    <Layout>
      <Content style={{ padding: '30px' }}>
        <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between' }}>
          <h2>Bail Systems</h2>
          <CreateBtn to={`/surveys/${surveyId}/bails/create`}>
            <PlusOutlined /> New Bail System
          </CreateBtn>
        </div>
        <Table
          columns={columns}
          dataSource={bails}
          rowKey={(record) => record.bail.id}
          pagination={{ pageSize: 20 }}
        />
      </Content>
    </Layout>
  );
};

export default BailSystems;
```

### 2.5 Create/Edit Form

**File:** `containers/BailSystems/BailForm.js`

```javascript
import React, { useState, useEffect } from 'react';
import { useParams, useHistory } from 'react-router-dom';
import {
  Form, Input, Select, Button, Switch, Card, Space, Divider,
  TimePicker, DatePicker, InputNumber, Spin, message, Alert
} from 'antd';
import { SaveOutlined, EyeOutlined, ArrowLeftOutlined } from '@ant-design/icons';
import moment from 'moment';
import api from '../../services/api';
import ConditionBuilder from '../../components/ConditionBuilder';
import { Loading } from '../../components/UI';

const { Option } = Select;
const { TextArea } = Input;

const BailForm = () => {
  const { surveyId, bailId } = useParams();
  const history = useHistory();
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(!!bailId);
  const [saving, setSaving] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [previewResult, setPreviewResult] = useState(null);
  const [timing, setTiming] = useState('immediate');
  const [forms, setForms] = useState([]);

  const isEdit = !!bailId;

  useEffect(() => {
    loadForms();
    if (isEdit) {
      loadBail();
    }
  }, [surveyId, bailId]);

  const loadForms = async () => {
    try {
      // Load available forms for this survey (for destination_form dropdown)
      const res = await api.fetcher({ path: `/surveys` });
      const surveys = await res.json();
      const survey = surveys.find(s => s.id === surveyId);
      if (survey) {
        // Get forms from this survey
        setForms(survey.forms || []);
      }
    } catch (err) {
      console.error('Failed to load forms:', err);
    }
  };

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
        // Invalid JSON, ignore
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
      history.push(`/surveys/${surveyId}/bails`);
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
        onClick={() => history.push(`/surveys/${surveyId}/bails`)}
        style={{ marginBottom: 16 }}
      >
        Back to Bail Systems
      </Button>

      <h2>{isEdit ? 'Edit' : 'Create'} Bail System</h2>

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
                  <Option value="Europe/London">Europe/London</Option>
                  <Option value="Asia/Tokyo">Asia/Tokyo</Option>
                  {/* Add more timezones as needed */}
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
          <Button onClick={() => history.push(`/surveys/${surveyId}/bails`)}>
            Cancel
          </Button>
        </Space>
      </Form>
    </div>
  );
};

export default BailForm;
```

### 2.6 Condition Builder Component

**File:** `components/ConditionBuilder/ConditionBuilder.js`

This is the most complex component - it handles nested AND/OR conditions with different condition types.

```javascript
import React from 'react';
import { Select, Input, InputNumber, Button, Card, Space, Radio } from 'antd';
import { PlusOutlined, DeleteOutlined } from '@ant-design/icons';
import styled from 'styled-components/macro';

const { Option } = Select;

const ConditionCard = styled(Card)`
  margin-bottom: 8px;
  .ant-card-body {
    padding: 12px;
  }
`;

const NestedContainer = styled.div`
  margin-left: 24px;
  padding-left: 16px;
  border-left: 2px solid #e8e8e8;
`;

// Condition types and their required fields
const CONDITION_TYPES = {
  form: { label: 'Form', fields: ['value'] },
  state: { label: 'State', fields: ['value'] },
  elapsed_time: { label: 'Elapsed Time', fields: ['form', 'question_ref', 'duration'] },
  timeout: { label: 'Timeout', fields: ['duration'] },
  metadata: { label: 'Metadata', fields: ['key', 'value'] },
};

const STATE_OPTIONS = [
  'START',
  'RESPONDING',
  'WAIT_EXTERNAL_EVENT',
  'END',
  'BLOCKED',
  'ERROR',
];

// Simple condition editor
const SimpleCondition = ({ condition, onChange, onDelete }) => {
  const type = condition.type || 'form';

  const handleTypeChange = (newType) => {
    // Reset to default values for new type
    const newCondition = { type: newType };
    if (newType === 'form' || newType === 'state') {
      newCondition.value = '';
    } else if (newType === 'elapsed_time') {
      newCondition.form = '';
      newCondition.question_ref = '';
      newCondition.duration = '1 week';
    } else if (newType === 'timeout') {
      newCondition.duration = '4 weeks';
    } else if (newType === 'metadata') {
      newCondition.key = '';
      newCondition.value = '';
    }
    onChange(newCondition);
  };

  const handleFieldChange = (field, value) => {
    onChange({ ...condition, [field]: value });
  };

  return (
    <ConditionCard size="small">
      <Space direction="vertical" style={{ width: '100%' }}>
        <Space>
          <Select
            value={type}
            onChange={handleTypeChange}
            style={{ width: 150 }}
          >
            {Object.entries(CONDITION_TYPES).map(([key, { label }]) => (
              <Option key={key} value={key}>{label}</Option>
            ))}
          </Select>
          <Button
            icon={<DeleteOutlined />}
            onClick={onDelete}
            type="text"
            danger
            size="small"
          />
        </Space>

        {/* Fields based on type */}
        {(type === 'form') && (
          <Input
            placeholder="Form shortcode (e.g., onboarding_v1)"
            value={condition.value || ''}
            onChange={(e) => handleFieldChange('value', e.target.value)}
          />
        )}

        {(type === 'state') && (
          <Select
            placeholder="Select state"
            value={condition.value || undefined}
            onChange={(v) => handleFieldChange('value', v)}
            style={{ width: '100%' }}
          >
            {STATE_OPTIONS.map(s => (
              <Option key={s} value={s}>{s}</Option>
            ))}
          </Select>
        )}

        {(type === 'elapsed_time') && (
          <>
            <Input
              placeholder="Form shortcode"
              value={condition.form || ''}
              onChange={(e) => handleFieldChange('form', e.target.value)}
              addonBefore="Form"
            />
            <Input
              placeholder="Question reference"
              value={condition.question_ref || ''}
              onChange={(e) => handleFieldChange('question_ref', e.target.value)}
              addonBefore="Question"
            />
            <Input
              placeholder="e.g., 4 weeks, 30 days"
              value={condition.duration || ''}
              onChange={(e) => handleFieldChange('duration', e.target.value)}
              addonBefore="Duration"
            />
          </>
        )}

        {(type === 'timeout') && (
          <Input
            placeholder="e.g., 4 weeks, 30 days"
            value={condition.duration || ''}
            onChange={(e) => handleFieldChange('duration', e.target.value)}
            addonBefore="Since last response"
          />
        )}

        {(type === 'metadata') && (
          <>
            <Input
              placeholder="Metadata key"
              value={condition.key || ''}
              onChange={(e) => handleFieldChange('key', e.target.value)}
              addonBefore="Key"
            />
            <Input
              placeholder="Expected value"
              value={condition.value || ''}
              onChange={(e) => handleFieldChange('value', e.target.value)}
              addonBefore="Value"
            />
          </>
        )}
      </Space>
    </ConditionCard>
  );
};

// Compound condition editor (AND/OR)
const CompoundCondition = ({ condition, onChange, onDelete, depth = 0 }) => {
  const operator = condition.operator || 'and';
  const children = condition.vars || [];

  const handleOperatorChange = (newOp) => {
    onChange({ ...condition, operator: newOp });
  };

  const handleChildChange = (index, newChild) => {
    const newVars = [...children];
    newVars[index] = newChild;
    onChange({ ...condition, vars: newVars });
  };

  const handleChildDelete = (index) => {
    const newVars = children.filter((_, i) => i !== index);
    // If only one child left, replace compound with that child
    if (newVars.length === 1) {
      onChange(newVars[0]);
    } else {
      onChange({ ...condition, vars: newVars });
    }
  };

  const handleAddCondition = (isCompound) => {
    const newChild = isCompound
      ? { operator: 'and', vars: [{ type: 'form', value: '' }] }
      : { type: 'form', value: '' };
    onChange({ ...condition, vars: [...children, newChild] });
  };

  return (
    <Card
      size="small"
      style={{ marginBottom: 8, background: depth % 2 === 0 ? '#fafafa' : '#fff' }}
      title={
        <Space>
          <Radio.Group
            value={operator}
            onChange={(e) => handleOperatorChange(e.target.value)}
            size="small"
          >
            <Radio.Button value="and">AND</Radio.Button>
            <Radio.Button value="or">OR</Radio.Button>
          </Radio.Group>
          <span style={{ color: '#666', fontSize: 12 }}>
            (all conditions must match)
          </span>
          {depth > 0 && (
            <Button
              icon={<DeleteOutlined />}
              onClick={onDelete}
              type="text"
              danger
              size="small"
            />
          )}
        </Space>
      }
    >
      <NestedContainer>
        {children.map((child, index) => (
          <ConditionNode
            key={index}
            condition={child}
            onChange={(c) => handleChildChange(index, c)}
            onDelete={() => handleChildDelete(index)}
            depth={depth + 1}
          />
        ))}
        <Space style={{ marginTop: 8 }}>
          <Button
            icon={<PlusOutlined />}
            onClick={() => handleAddCondition(false)}
            size="small"
          >
            Add Condition
          </Button>
          <Button
            icon={<PlusOutlined />}
            onClick={() => handleAddCondition(true)}
            size="small"
          >
            Add Group
          </Button>
        </Space>
      </NestedContainer>
    </Card>
  );
};

// Dispatcher that renders the right component based on condition type
const ConditionNode = ({ condition, onChange, onDelete, depth = 0 }) => {
  // Check if it's a compound condition (has operator)
  if (condition.operator) {
    return (
      <CompoundCondition
        condition={condition}
        onChange={onChange}
        onDelete={onDelete}
        depth={depth}
      />
    );
  }

  // Simple condition
  return (
    <SimpleCondition
      condition={condition}
      onChange={onChange}
      onDelete={onDelete}
    />
  );
};

// Main builder component (AntD Form-compatible)
const ConditionBuilder = ({ value, onChange }) => {
  const condition = value || { type: 'form', value: '' };

  const handleChange = (newCondition) => {
    onChange?.(newCondition);
  };

  const handleConvertToCompound = () => {
    // Wrap current condition in AND
    onChange?.({
      operator: 'and',
      vars: [condition],
    });
  };

  return (
    <div>
      <ConditionNode
        condition={condition}
        onChange={handleChange}
        onDelete={() => onChange?.({ type: 'form', value: '' })}
      />

      {!condition.operator && (
        <Button
          type="dashed"
          onClick={handleConvertToCompound}
          style={{ marginTop: 8 }}
          block
        >
          <PlusOutlined /> Add Another Condition (AND/OR)
        </Button>
      )}
    </div>
  );
};

export default ConditionBuilder;
```

### 2.7 Event History View

**File:** `containers/BailSystems/BailEvents.js`

```javascript
import React, { useState, useEffect } from 'react';
import { useParams, useHistory } from 'react-router-dom';
import { Table, Layout, Tag, Button, Card } from 'antd';
import { ArrowLeftOutlined } from '@ant-design/icons';
import api from '../../services/api';
import { Loading } from '../../components/UI';

const { Content } = Layout;

const BailEvents = () => {
  const { surveyId, bailId } = useParams();
  const history = useHistory();
  const [events, setEvents] = useState(null);
  const [bail, setBail] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadData();
  }, [surveyId, bailId]);

  const loadData = async () => {
    try {
      const [eventsRes, bailRes] = await Promise.all([
        api.fetcher({ path: `/surveys/${surveyId}/bails/${bailId}/events` }),
        api.fetcher({ path: `/surveys/${surveyId}/bails/${bailId}` }),
      ]);

      const eventsData = await eventsRes.json();
      const bailData = await bailRes.json();

      setEvents(eventsData.events || []);
      setBail(bailData.bail);
    } catch (err) {
      console.error('Failed to load events:', err);
    } finally {
      setLoading(false);
    }
  };

  const columns = [
    {
      title: 'Timestamp',
      dataIndex: 'timestamp',
      key: 'timestamp',
      render: (ts) => new Date(ts).toLocaleString(),
      sorter: (a, b) => new Date(b.timestamp) - new Date(a.timestamp),
      defaultSortOrder: 'descend',
    },
    {
      title: 'Event Type',
      dataIndex: 'event_type',
      key: 'event_type',
      render: (type) => (
        <Tag color={type === 'execution' ? 'green' : 'red'}>
          {type}
        </Tag>
      ),
    },
    {
      title: 'Users Matched',
      dataIndex: 'users_matched',
      key: 'users_matched',
    },
    {
      title: 'Users Bailed',
      dataIndex: 'users_bailed',
      key: 'users_bailed',
    },
    {
      title: 'Error',
      dataIndex: 'error',
      key: 'error',
      render: (error) => error ? (
        <span style={{ color: 'red' }}>{error.message || JSON.stringify(error)}</span>
      ) : '-',
    },
  ];

  if (loading) return <Loading>Loading events...</Loading>;

  return (
    <Layout>
      <Content style={{ padding: '30px' }}>
        <Button
          icon={<ArrowLeftOutlined />}
          onClick={() => history.push(`/surveys/${surveyId}/bails`)}
          style={{ marginBottom: 16 }}
        >
          Back to Bail Systems
        </Button>

        <Card title={`Event History: ${bail?.name || 'Bail'}`}>
          <Table
            columns={columns}
            dataSource={events}
            rowKey="id"
            pagination={{ pageSize: 50 }}
          />
        </Card>
      </Content>
    </Layout>
  );
};

export default BailEvents;
```

---

## Part 3: Integration Checklist

### 3.1 Dashboard-Server Files to Create
- [ ] `api/bails/index.js`
- [ ] `api/bails/bails.routes.js`
- [ ] `api/bails/bails.controller.js`
- [ ] `utils/bails/index.js`
- [ ] `utils/bails/bails.util.js`

### 3.2 Dashboard-Server Files to Modify
- [ ] `api/index.js` - Mount bails routes
- [ ] `config/index.js` - Add EXODUS_API_URL config
- [ ] `utils/index.js` - Export BailsUtil

### 3.3 Dashboard-Client Files to Create
- [ ] `containers/BailSystems/index.js`
- [ ] `containers/BailSystems/BailSystems.js`
- [ ] `containers/BailSystems/BailForm.js`
- [ ] `containers/BailSystems/BailEvents.js`
- [ ] `containers/BailSystems/BailSystems.css`
- [ ] `components/ConditionBuilder/index.js`
- [ ] `components/ConditionBuilder/ConditionBuilder.js`
- [ ] `components/ConditionBuilder/style.js`

### 3.4 Dashboard-Client Files to Modify
- [ ] `root.js` - Add bail routes
- [ ] `containers/index.js` - Export BailSystems components
- [ ] `components/index.js` - Export ConditionBuilder

---

## Part 4: Navigation Integration

### 4.1 Add Menu Link

In the survey sidebar/menu, add a link to bail systems:

```javascript
// In SurveyScreen or similar
<Menu.Item key="bails">
  <Link to={`/surveys/${surveyId}/bails`}>
    Bail Systems
  </Link>
</Menu.Item>
```

### 4.2 Survey-Level Navigation

The bail systems should be accessible from:
1. Survey sidebar menu
2. Survey settings page
3. Direct URL: `/surveys/:surveyId/bails`

---

## Part 5: Environment Configuration

### 5.1 Dashboard-Server Environment Variables

```bash
# Exodus API configuration
EXODUS_API_URL=http://exodus-api:8080  # Kubernetes service name
```

### 5.2 Kubernetes Configuration

Add to dashboard-server deployment:
```yaml
env:
  - name: EXODUS_API_URL
    value: "http://exodus-api:8080"
```

---

## Implementation Order

1. **Dashboard-Server** (proxy layer)
   - Add config for Exodus URL
   - Create bails utility module
   - Create bails controller
   - Create bails routes
   - Mount routes in main router
   - Test with curl

2. **Dashboard-Client** (UI)
   - Create ConditionBuilder component
   - Create BailSystems list view
   - Create BailForm (create/edit)
   - Create BailEvents view
   - Add routing
   - Add navigation links
   - Test end-to-end

3. **Integration**
   - Update Kubernetes configs
   - Deploy and test
