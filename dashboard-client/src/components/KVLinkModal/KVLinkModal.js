import React from 'react';
import PropTypes from 'prop-types';
import { useHistory } from 'react-router-dom';
import { Form } from 'antd';
import LinkModal from '../LinkModal';


const KVLinkModal = ({ items, title, description, successText, handleCreate, loading, back }) => {
  const history = useHistory();
  const localBack = back || (() => history.go(-1));
  const [form] = Form.useForm();

  items.forEach(i => form.setFieldsValue({ [i.name]: i.initialValue }));

  const success = async () => {
    const vals = items.reduce((a, i) => ({ ...a, [i.name]: form.getFieldValue(i.name) }), {});
    await handleCreate(vals);
    back();
  }

  const content = <>
    <span className="description">
      {description}
    </span>
    <Form
      form={form}
      labelCol={{ span: 10 }}
      style={{ marginLeft: 'auto', marginRight: 'auto' }}
    >
      {items.map(i => (
        <Form.Item
          key={i.name}
          label={i.label}
          name={i.name}
          rules={[{ required: true, message: 'Please provide a valid value' }]}
        >
          {i.input}
        </Form.Item>
      ))}
    </Form>
  </>

  return (
    <LinkModal
      successText={successText}
      title={title}
      back={localBack}
      loading={loading}
      content={content}
      success={success}
    />
  );
};


KVLinkModal.propTypes = {
  items: PropTypes.array.isRequired,
  title: PropTypes.string.isRequired,
  description: PropTypes.string.isRequired,
  successText: PropTypes.string.isRequired,
  handleCreate: PropTypes.func.isRequired,
  loading: PropTypes.bool,
};

export default KVLinkModal;
