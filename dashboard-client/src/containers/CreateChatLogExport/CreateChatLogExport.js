import React, { useState } from 'react';
import { useLocation, useHistory } from 'react-router-dom';
import { PrimaryBtn } from '../../components/UI';
import {
  Form, Switch, Spin
} from 'antd';

import startExport from '../../services/api/startExport';

const CreateChatLogExport = () => {
  const history = useHistory();
  const location = useLocation();
  const query = new URLSearchParams(location.search);
  const survey = decodeURIComponent(query.get('survey_name'));
  const [loading, setLoading] = useState(false);

  const onFinish = async (body) => {
    setLoading(true);
    await startExport(survey, body, 'chat_log');

    // Short wait -- the "Started" row is already inserted by the server,
    // but give a moment before navigating back.
    await new Promise(resolve => setTimeout(resolve, 1000));

    setLoading(false);
    history.goBack();
  };

  const [form] = Form.useForm();

  const defaults = {
    include_metadata: false,
    include_raw_payload: false,
  };

  return (
    <Spin spinning={loading}>

      <h1 style={{ margin: '60px auto', width: '800px' }}> Export Chat Log: {survey}</h1>

      <Form
        labelCol={{ span: 10 }}
        wrapperCol={{ span: 8 }}
        style={{ maxWidth: '1000px', marginLeft: 'auto', marginRight: 'auto', marginTop: '40px' }}
        form={form}
        onFinish={onFinish}
        initialValues={defaults}
        size="large"
      >

        <Form.Item
          label="Include metadata"
          name="include_metadata"
          valuePropName="checked"
        >
          <Switch />
        </Form.Item>

        <Form.Item
          label="Include raw payload"
          name="include_raw_payload"
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

export default CreateChatLogExport;
