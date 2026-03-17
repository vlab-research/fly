import React, { useState } from 'react';
import PropTypes from 'prop-types';
import {
  Upload, Table, Alert, Button, Space,
} from 'antd';
import { DownloadOutlined } from '@ant-design/icons';

const parseCSV = (text) => {
  const lines = text.trim().split('\n');
  const errors = [];
  const users = [];

  let startIdx = 0;
  const firstLine = lines[0].trim().toLowerCase();
  if (firstLine.includes('userid') || firstLine.includes('user_id')) {
    startIdx = 1;
  }

  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const parts = line.split(',').map(s => s.trim());
    if (parts.length !== 3) {
      errors.push(`Row ${i + 1}: expected 3 columns (userid, pageid, shortcode), got ${parts.length}`);
      continue;
    }

    const [userid, pageid, shortcode] = parts;
    if (!userid) errors.push(`Row ${i + 1}: userid is empty`);
    if (!pageid) errors.push(`Row ${i + 1}: pageid is empty`);
    if (!shortcode) errors.push(`Row ${i + 1}: shortcode is empty`);

    if (userid && pageid && shortcode) {
      users.push({ userid, pageid, shortcode });
    }
  }

  return { users, errors };
};

const downloadTemplate = () => {
  const csv = 'userid,pageid,shortcode\n';
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'bail_user_list_template.csv';
  a.click();
  URL.revokeObjectURL(url);
};

const CsvUpload = ({ value, onChange }) => {
  const [errors, setErrors] = useState([]);
  const [fileName, setFileName] = useState(null);

  const handleFile = (file) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const { users, errors: parseErrors } = parseCSV(e.target.result);
      if (users.length > 1000) {
        setErrors([`Too many rows: ${users.length}. Maximum is 1000.`]);
        onChange([]);
        return;
      }
      setErrors(parseErrors);
      setFileName(file.name);
      onChange(users);
    };
    reader.onerror = () => {
      setErrors(['Failed to read file. Please try again.']);
      onChange([]);
    };
    reader.readAsText(file);
    return false;
  };

  const columns = [
    {
      title: 'User ID',
      dataIndex: 'userid',
      key: 'userid',
    },
    {
      title: 'Page ID',
      dataIndex: 'pageid',
      key: 'pageid',
    },
    {
      title: 'Destination',
      dataIndex: 'shortcode',
      key: 'shortcode',
    },
  ];

  const tableData = value ? value.slice(0, 10).map((user, index) => ({
    ...user,
    key: index,
  })) : [];

  return (
    <div>
      <Space style={{ marginBottom: 16 }}>
        <Button
          type="primary"
          icon={<DownloadOutlined />}
          onClick={downloadTemplate}
        >
          Download CSV Template
        </Button>
      </Space>

      <Upload.Dragger
        accept=".csv"
        beforeUpload={handleFile}
        showUploadList={false}
        style={{ marginBottom: 16 }}
      >
        <p>Click or drag CSV file to upload</p>
        <p>Format: userid, pageid, shortcode (max 1000 rows)</p>
      </Upload.Dragger>

      {errors.length > 0 && (
        <Alert
          type="error"
          message={`${errors.length} validation error${errors.length !== 1 ? 's' : ''}`}
          description={(
            <ul style={{ marginBottom: 0, paddingLeft: 20 }}>
              {errors.map((err, i) => (
                <li key={i}>{err}</li>
              ))}
            </ul>
          )}
          style={{ marginBottom: 16 }}
        />
      )}

      {value && value.length > 0 && errors.length === 0 && (
        <>
          <Alert
            type="success"
            message={`${value.length} user${value.length !== 1 ? 's' : ''} loaded from ${fileName}`}
            style={{ marginBottom: 16 }}
          />
          <Table
            dataSource={tableData}
            columns={columns}
            pagination={false}
            size="small"
            style={{ marginBottom: value.length > 10 ? 16 : 0 }}
          />
          {value.length > 10 && (
            <p style={{ color: '#666', marginTop: 8 }}>
              ... and
              {' '}
              {value.length - 10}
              {' '}
              more
            </p>
          )}
        </>
      )}
    </div>
  );
};

CsvUpload.propTypes = {
  value: PropTypes.arrayOf(PropTypes.shape({
    userid: PropTypes.string.isRequired,
    pageid: PropTypes.string.isRequired,
    shortcode: PropTypes.string.isRequired,
  })),
  onChange: PropTypes.func.isRequired,
};

CsvUpload.defaultProps = {
  value: [],
};

export default CsvUpload;
