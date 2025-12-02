import React from 'react';
import PropTypes from 'prop-types';
import { Select, Input, Button, Card, Space, Radio } from 'antd';
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
  form: { label: 'Form' },
  state: { label: 'State' },
  elapsed_time: { label: 'Elapsed Time' },
  timeout: { label: 'Timeout' },
  metadata: { label: 'Metadata' },
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

SimpleCondition.propTypes = {
  condition: PropTypes.object.isRequired,
  onChange: PropTypes.func.isRequired,
  onDelete: PropTypes.func.isRequired,
};

// Forward declaration for recursive rendering
let ConditionNode;

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

  const operatorText = operator === 'and' ? 'all conditions must match' : 'any condition must match';

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
            ({operatorText})
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

CompoundCondition.propTypes = {
  condition: PropTypes.object.isRequired,
  onChange: PropTypes.func.isRequired,
  onDelete: PropTypes.func.isRequired,
  depth: PropTypes.number,
};

// Dispatcher that renders the right component based on condition type
ConditionNode = ({ condition, onChange, onDelete, depth = 0 }) => {
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

ConditionNode.propTypes = {
  condition: PropTypes.object.isRequired,
  onChange: PropTypes.func.isRequired,
  onDelete: PropTypes.func.isRequired,
  depth: PropTypes.number,
};

// Main builder component (AntD Form-compatible)
const ConditionBuilder = ({ value, onChange }) => {
  const condition = value || { type: 'form', value: '' };

  const handleChange = (newCondition) => {
    if (onChange) {
      onChange(newCondition);
    }
  };

  const handleConvertToCompound = () => {
    // Wrap current condition in AND
    if (onChange) {
      onChange({
        operator: 'and',
        vars: [condition],
      });
    }
  };

  return (
    <div>
      <ConditionNode
        condition={condition}
        onChange={handleChange}
        onDelete={() => handleChange({ type: 'form', value: '' })}
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

ConditionBuilder.propTypes = {
  value: PropTypes.object,
  onChange: PropTypes.func,
};

export default ConditionBuilder;
