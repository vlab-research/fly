import React, { useEffect, useState } from 'react';
import { Input } from 'antd';
import { useLocation } from 'react-router-dom';
import api from '../../services/api';
import './Reloadly.css';
import KVLinkModal from '../../components/KVLinkModal';

const Reloadly = () => {
  const location = useLocation();
  const query = new URLSearchParams(location.search);
  const key = query.get('key');

  const [cred, setCred] = useState(null);
  const [items, setItems] = useState([]);

  const getCredentials = async () => {
    const res = await api.fetcher({
      path: '/credentials', method: 'GET',
    });
    const allCreds = await res.json();
    const rCred = allCreds.filter(e => e.entity === 'reloadly' && e.key === key)[0];
    setCred(rCred);

    const id = rCred && rCred.details && rCred.details.id ? rCred.details.id : '';
    const secret = rCred && rCred.details && rCred.details.secret ? rCred.details.secret : '';

    const items = [
      { name: 'key', label: 'Name', initialValue: key, input: <Input disabled={!!key} /> },
      { name: 'api_client_id', label: 'API Client ID', initialValue: id, input: <Input /> },
      { name: 'api_client_secret', label: 'API Client Secret', initialValue: secret, input: <Input.Password /> },
    ]

    setItems(items);
  }

  useEffect(() => {
    getCredentials();
  }, []);

  const handleCreate = async ({ key, api_client_id: id, api_client_secret: secret }) => {
    if (!id || !secret) {
      alert('You must provide valid credentials.');
      return;
    }

    const body = { entity: 'reloadly', key, details: { id, secret } };
    await api.fetcher({
      path: '/credentials', method: cred ? 'PUT' : 'POST', body, raw: true,
    });
  };

  const description = `To connect to Reloadly provide your "API Client ID" and "API Client Secret". You can find these values in the developers section once you have logged into Reloadly.`


  return (
    <KVLinkModal
      items={items}
      title="Connect Reloadly"
      description={description}
      successText={!cred ? "Create" : "Update"}
      handleCreate={handleCreate}
      loading={items === []}
    />
  );
};

Reloadly.propTypes = {};

export default Reloadly;
