import React, { useState } from 'react';
import { useLocation, useHistory } from 'react-router-dom';
import {
  Form, Switch, Checkbox, DatePicker, Spin,
} from 'antd';
import moment from 'moment';
import { PrimaryBtn } from '../../components/UI';

import startExport from '../../services/api/startExport';

const EVENT_GROUP_OPTIONS = [
  { label: 'Messages (echo, text, quick reply, postback)', value: 'conversation' },
  { label: 'Referrals & Opt-ins', value: 'referrals' },
  { label: 'Bail Events', value: 'bails' },
  { label: 'Payment Events', value: 'payments' },
  { label: 'Moviehouse & Linksniffer', value: 'external_tracking' },
  { label: 'Retries & Follow-ups', value: 'retries' },
  { label: 'System Events (machine reports, platform responses)', value: 'system' },
  { label: 'Watermarks & Other', value: 'other' },
];

const ALL_GROUPS = EVENT_GROUP_OPTIONS.map(o => o.value);

const CreateFullMessagesExport = () => {
  const history = useHistory();
  const location = useLocation();
  const query = new URLSearchParams(location.search);
  const survey = decodeURIComponent(query.get('survey_name'));
  const [loading, setLoading] = useState(false);

  const onFinish = async (formValues) => {
    setLoading(true);
    const { start_time, end_time, ...rest } = formValues;
    const body = { ...rest };
    if (start_time) body.start_time = moment(start_time).utc().toISOString();
    if (end_time) body.end_time = moment(end_time).utc().toISOString();
    await startExport(survey, body, 'full_messages');

    setLoading(false);
    history.goBack();
  };

  const [form] = Form.useForm();

  const defaults = {
    event_groups: ALL_GROUPS,
    include_raw_json: false,
  };

  return (
    <Spin spinning={loading}>

      <h1 style={{ margin: '60px auto', width: '800px' }}>
        {' Export Full Messages: '}
        {survey}
      </h1>

      <Form
        labelCol={{ span: 10 }}
        wrapperCol={{ span: 8 }}
        style={{
          maxWidth: '1000px', marginLeft: 'auto', marginRight: 'auto', marginTop: '40px',
        }}
        form={form}
        onFinish={onFinish}
        initialValues={defaults}
        size="large"
      >

        <Form.Item
          label="Event types to include"
          name="event_groups"
        >
          <Checkbox.Group options={EVENT_GROUP_OPTIONS} style={{ display: 'flex', flexDirection: 'column', gap: '8px' }} />
        </Form.Item>

        <Form.Item
          label="Start time (UTC, optional)"
          name="start_time"
          help="Only include messages at or after this UTC instant. Leave blank for no lower bound."
        >
          <DatePicker showTime format="YYYY-MM-DD HH:mm" style={{ width: '100%' }} />
        </Form.Item>

        <Form.Item
          label="End time (UTC, optional)"
          name="end_time"
          help="Only include messages strictly before this UTC instant. Leave blank for no upper bound."
        >
          <DatePicker showTime format="YYYY-MM-DD HH:mm" style={{ width: '100%' }} />
        </Form.Item>

        <Form.Item
          label="Include raw JSON"
          name="include_raw_json"
          valuePropName="checked"
        >
          <Switch />
        </Form.Item>

        <Form.Item style={{ marginTop: '4em' }} wrapperCol={{ offset: 8, span: 16 }}>
          <PrimaryBtn> START EXPORT </PrimaryBtn>
        </Form.Item>

      </Form>
    </Spin>
  );
};

export default CreateFullMessagesExport;
