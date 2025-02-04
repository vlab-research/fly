import React, { useState, useContext } from 'react';
import moment from 'moment';
import PropTypes from 'prop-types';
import { useParams, useHistory } from 'react-router-dom';
import { PrimaryBtn } from '../../components/UI';
import { MinusCircleOutlined, PlusOutlined } from '@ant-design/icons';
import {
  Form, Input, Button, Space, Spin, DatePicker, Select, Switch
} from 'antd';
import ApiClient from '../../services/api';
import { Survey } from '../Surveys/Surveys';

const { Option } = Select;

const Timeout = ({ field, remove, initialValues }) => {

  const [type, setType] = useState(initialValues && initialValues.type)

  return (
    <Space
      key= { field.key }
      style = {{
        display: 'flex',
        maxWidth: '800px',
        marginBottom: 8,
        marginRight: 'auto',
        marginLeft: 'auto',
      }
              }
      align = "baseline"
    >

      <Form.Item
        { ...field }
        name = { [field.name, 'name']}
        fieldKey = { [field.fieldKey, 'name']}
        wrapperCol = {{ span: 100 }}
        rules = { [{ required: true, message: 'Missing name' }]}
      >
        <Input placeholder="Name" />
      </Form.Item>

      < Form.Item
        {...field }
        wrapperCol = {{ span: 100 }}
        name = { [field.name, 'type']}
        fieldKey = { [field.fieldKey, 'type']}
        rules = { [{ required: true, message: 'Missing type' }]}
      >
        <Select placeholder="Timeout Type" onChange = { setType } >
          <Option value="relative" > Relative </Option>
          < Option value = "absolute" > Absolute </Option>
        </Select>
      </Form.Item>


      < Form.Item
        {...field }
        wrapperCol = {{ span: 100 }}
        name = { [field.name, 'value']}
        fieldKey = { [field.fieldKey, 'value']}
        rules = { [{ required: true, message: 'Missing value' }]}
      >
        { type === 'absolute' ?
          <DatePicker showTime placeholder = "Timeout Date" />
          : <Input placeholder="Timeout Value" />}


      </Form.Item>

      < MinusCircleOutlined onClick = {() => remove(field.name)} />
    </Space>
  )
}


const Timeouts = ({ initialValues }) => {

  return (
    <>
      <Form.Item label= "  " colon = { false} >
        <Form.List name="timeouts" >
          {(fields, { add, remove }) => (
            <>
              {
                fields.map(field => (
                  <Timeout key= { field.key } remove = { remove } field = { field } initialValues = { initialValues && initialValues[field.key]} />
                ))}

              <Form.Item style={
                           {
                             display: 'flex', maxWidth: '800px', marginBottom: 8, marginRight: 'auto', marginLeft: 'auto',
                           }
                         }
              >
                <Button type="dashed" onClick = {() => add()} block icon = {< PlusOutlined />}>
                  Add Timeout
                </Button>
              </Form.Item>
            </>
          )}
        </Form.List>
      </Form.Item>
    </>
  );
};

const OffTime = ({ initialValues }) => {
  return (
    <>
      <Form.Item
        style={{
          display: 'flex', maxWidth: '800px', marginBottom: 8, marginRight: 'auto', marginLeft: 'auto',
        }}
        name="killed"
        valuePropName="checked"
        initialValue={!!initialValues}
        rules={[{ required: false, message: 'You did not pick an end time' }]}
        disabled={!!initialValues}
      >
        <Switch />
      </Form.Item>
    </>
  );
};

const FormScreen = ({ forms }) => {

  const { surveyid } = useParams();
  const history = useHistory();
  const { setSurveys } = useContext(Survey);
  const [loading, setLoading] = useState(false);

  const handle = async (res) => {
    if (res.status === 200) {
      return res.json();
    }
    const t = await res.text();
    throw new Error(t);
  }

  const onFinish = async (body) => {
    setLoading(true)

    body.off_time = body.killed ? new Date() : undefined;

    // use surveyid instead 
    await ApiClient.fetcher({ method: 'PUT', path: `/surveys/${surveyid}/settings`, body })
      .then(handle);

    await ApiClient.fetcher({ method: 'GET', path: `/surveys` })
      .then(handle)
      .then(setSurveys);

    setLoading(false);
    history.push(`/surveys/${survey_name}`)
  };

  const hydrateTimeout = (timeout) => {
    if (timeout.type === 'absolute') {
      return { ...timeout, value: timeout.value && moment(timeout.value) };
    }
    return timeout;
  };

  // const accounts = Hook.useMountFetch({ path: '/credentials' }, null)[0];
  // console.log(accounts)
  // Get facebook pages
  // create testing links for each page
  // create a component which shows all the links for each page...

  const { off_time, timeouts, shortcode, survey_name } = forms.find(s => s.id === surveyid);

  const version = forms.reverse().filter(s => s.shortcode === shortcode).map(s => s.id).indexOf(surveyid) + 1;

  const data = { off_time, timeouts };

  const initialValues = {
    killed: !!data.off_time,
    timeouts: data.timeouts ? data.timeouts.map(hydrateTimeout) : [],
  };
 
  const [form] = Form.useForm();
  return (
    <div className= "FormScreen" >
      <div>

        <h2>
          { `${shortcode} v${version}` }
        </h2>
      </div>


      < Spin spinning = { loading } >
        <Form
          onFinish={ onFinish }
          initialValues = { initialValues }
          style = {{ maxWidth: '1000px', marginLeft: 'auto', marginRight: 'auto' }
                  }
          form = { form }
          size = "large"
        >

          <section>
            <h2>Timeouts </h2>
            < Timeouts initialValues = { initialValues.timeouts } />
          </section>

          < section >
            <h2>Kill Switch </h2>
            <p> Warning: once you flip this switch, you can never go back. It's over, rover. </p>
            < OffTime initialValues = { initialValues.off_time } />
          </section>
          < Form.Item style = {{ marginTop: '4em' }} wrapperCol = {{ offset: 8, span: 16 }}>
            <PrimaryBtn>UPDATE </PrimaryBtn>
          </Form.Item>

        </Form>
      </Spin>

    </div>
  );
};

FormScreen.propTypes = {
  forms: PropTypes.arrayOf(PropTypes.object),
};


export default FormScreen;
