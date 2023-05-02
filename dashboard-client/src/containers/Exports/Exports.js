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
  let columns = [
    { title: 'Survey', dataIndex: 'survey_id' },
    { title: 'User', dataIndex: 'user_id' },
    { title: 'Time Exported', dataIndex: 'updated' },
    { title: 'Status', dataIndex: 'status' },
    { title: 'Download', dataIndex: 'export_link', render: DownloadLink },
  ];
  const [exports, setExports] = Hook.useMountFetch({ path: '/exports/status' }, []);

  if (exports === null) {
    return <Loading> (loading exports) </Loading>;
  }
    console.log(exports)
  return (
    <Layout style={{ height: '100%' }}>
      <Export.Provider value={{ setExports }}>
        <Content style={{ padding: '30px' }}>
        <Table
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
