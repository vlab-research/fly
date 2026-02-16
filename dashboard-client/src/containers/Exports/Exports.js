import React from 'react';
import { Link } from 'react-router-dom';
import { Table, Layout } from 'antd';
import { Loading } from '../../components/UI';
import { Hook } from '../../services';
import './Exports.css';

const { Content } = Layout;
export const Export = React.createContext(null);

const Exports = () => {

  const DownloadLink = (text, record) => (<Link to={{pathname: text }} target="_blank"> DOWNLOAD </Link>);
  // Note: data comes back newest-first from the server (ORDER BY updated DESC)
  let columns = [
    { title: 'Survey', dataIndex: 'survey_id' },
    { title: 'Source', dataIndex: 'source', render: (text) => text === 'chat_log' ? 'Chat Log' : 'Responses' },
    { title: 'User', dataIndex: 'user_id' },
    { title: 'Time Exported', dataIndex: 'updated' },
    { title: 'Status', dataIndex: 'status' },
    { title: 'Download', dataIndex: 'export_link', render: DownloadLink },
  ];
  const [exports, setExports] = Hook.useMountFetch({ path: '/exports/status' }, []);

  if (exports === null) {
    return <Loading> (loading exports) </Loading>;
  }
  return (
    <Layout style={{ height: '100%' }}>
      <Export.Provider value={{ setExports }}>
        <Content style={{ padding: '30px' }}>
        <Table
          rowKey="id"
          columns={columns}
          dataSource={exports}
          pagination={{ pageSize: 20 }}
        />
        </Content>
      </Export.Provider>
    </Layout>
  );
};


export default Exports;
