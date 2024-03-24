import React, { useEffect, useState } from 'react';
import { useLocation, useHistory } from 'react-router-dom';
import { Input } from 'antd';
import api from '../../services/api';
import KVLinkModal from '../../components/KVLinkModal'

const ApiKeys = () => {
  const history = useHistory();
  const location = useLocation();
  const query = new URLSearchParams(location.search);
  const key = query.get('key');

  const [items, setItems] = useState([])

  const [token, setToken] = useState(null)

  const getCredentials = async () => {
    let value = '';
    let disabled = false;

    if (key) {
      value = key;
      disabled = true;

      // don't allow this...
    }

    const items = [
      { name: 'name', label: 'Name of API Key', initialValue: value, input: <Input disabled={disabled} /> },
    ]

    setItems(items)
  }

  useEffect(() => {
    getCredentials();
  }, []);

  const handleCreate = async ({ name }) => {
    if (!name) {
      alert('You must provide a name to create an API key');
      return;
    }

    if (key) {
      alert('Nothing to do here for now...');
      return;
    }

    const body = { name };
    const res = await api.fetcher({
      path: '/auth/api-token', method: 'POST', body, raw: true
    });

    if (!res.ok) {
      const { error } = await res.json();
      return alert(`Sorry: ${error}`)
    }

    const b = await res.json();
    const { token } = b;

    setToken(token)
  }

  const onFinish = () => {
    console.log("how's this? now finish")
    history.go(-1);
  }

  const description = `To create a new API Key.`


  if (token) {
    return (
      <KVLinkModal
        items={[]}
        title="Your new token (keep it safe)"
        description={token}
        successText={"OK"}
        handleCreate={() => true}
        back={onFinish}
      />
    )
  }

  return (
    <>
      <KVLinkModal
        items={items}
        title="Create new API key"
        description={description}
        successText={"Create"}
        handleCreate={handleCreate}
        loading={items === []} 
        back={() => true}
      />
    </> 

  );
};

ApiKeys.propTypes = {};

export default ApiKeys;
