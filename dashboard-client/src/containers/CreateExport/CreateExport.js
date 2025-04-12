import React, { useState } from 'react';
import PropTypes from 'prop-types';
import { useLocation, useHistory } from 'react-router-dom';
import { PrimaryBtn } from '../../components/UI';
import {
  Form, Select, Input, Switch, Spin
} from 'antd';

import startExport from '../../services/api/startExport';
const { Option } = Select;

const CreateExport = () => {
  const history = useHistory();
  const location = useLocation();
  const query = new URLSearchParams(location.search);
  const survey = decodeURIComponent(query.get('survey_name'));
  const [loading, setLoading] = useState(false);

  // Get available typeform forms or authorize with Typeform
  const onFinish = async (body) => {
    setLoading(true)
    // quick hack until we have select

    if (body && body.metadata) {
      body.metadata = body.metadata.split(',').map(x => x.trim())
    }

    await startExport(survey, body)

    // artificial wait, hoping for exporter to catch up
    await new Promise(resolve => setTimeout(resolve, 4000));

    setLoading(false)
    history.push('/exports')
  };

  const [form] = Form.useForm();

  const defaults = {
    pivot: true,
    keep_final_answer: true,
    drop_duplicated_users: true,
    add_duration: true,
    response_value: "translated_response",
  };

  const [pivot, setPivot] = useState(true)

  return (
    <Spin spinning={loading}>

      <h1 style={{ margin: '60px auto', width: '800px' }}> Export {survey}</h1>


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
          label="Keep final answer only"
          name="keep_final_answer"
          valuePropName="checked"
        >
          <Switch />
        </Form.Item>

        <Form.Item
          label="Completely drop duplicated users"
          name="drop_duplicated_users"
          valuePropName="checked"
        >
          <Switch />
        </Form.Item>


        <Form.Item
          label="Add duration columns"
          name="add_duration"
          valuePropName="checked"
        >
          <Switch />
        </Form.Item>


        <Form.Item
          label="Drop all users without this variable"
          name="drop_users_without"
        >
          <Input placeholder="creative" />
        </Form.Item>


        <Form.Item
          label="Pivot data to wide format"
          name="pivot"
          valuePropName="checked"
        >
          <Switch onChange={setPivot} />
        </Form.Item>


        <Form.Item
          label="Response value on Pivot"
          name="response_value"
          rules={[{ required: pivot && true, message: 'If Pivot is true, this is required' }]}
        >

          <Select disabled={!pivot}>
            <Option value="response">Response</Option>
            <Option value="translated_response">Translated Response</Option>
          </Select>
        </Form.Item>


        <Form.Item
          label="Metadata to add as columns"
          name="metadata"
        >
          <Input placeholder="stratum_age, stratum_gender" />
        </Form.Item>



        <Form.Item style={{ marginTop: '4em' }} wrapperCol={{ offset: 8, span: 16 }}>
          <PrimaryBtn> START EXPORT </PrimaryBtn>
        </Form.Item>

      </Form>
    </Spin>
  );
};


CreateExport.propTypes = {
  surveys: PropTypes.arrayOf(PropTypes.object),
};


export default CreateExport;
