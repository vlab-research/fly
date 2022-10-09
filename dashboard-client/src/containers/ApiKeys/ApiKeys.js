import React, { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Input } from 'antd';
import api from '../../services/api';
import KVLinkModal from '../../components/KVLinkModal'

const ApiKeys = () => {
  const location = useLocation();
  const query = new URLSearchParams(location.search);
  const key = query.get('key');

  const [items, setItems] = useState([])

  const getCredentials = async () => {
    let variable = '';
    let value = '';
    let disabled = false;

    if (key) {
      const res = await api.fetcher({
        path: '/credentials', method: 'GET',
      });
      const allCreds = await res.json();
      const secrets = allCreds.filter(e => e.entity === 'api-key');
      const secret = secrets.find(c => c.name === key);
      if (!secret) {
        throw new Error("Attempting to update a secret that doesn't exist!");
      }

      variable = key;
      value = secret.details.name;
      disabled = true;
    }

    const items = [
      { name: 'name', label: 'Name of API Key', initialValue: variable, input: <Input disabled={disabled} /> },
    ]

    setItems(items)
  }

  useEffect(() => {
    getCredentials();
  }, []);

  const handleCreate = async ({ variable, value }) => {
    if (!variable || !value) {
      alert('You must provide both a variable and a value to create a secret.');
      return;
    }

    const body = { entity: 'secrets', key: variable, details: { value } };
    await api.fetcher({
      path: '/credentials', method: key ? 'PUT' : 'POST', body, raw: true,
    });
  }

  const description = `To add generic secrets provide the variable name and value here.`

  return (
    <KVLinkModal
      items={items}
      title="Add Generic Secrets"
      description={description}
      successText={!key ? "Create" : "Update"}
      handleCreate={handleCreate}
      loading={items === []}
    />
  );
};

ApiKeys.propTypes = {};

export default ApiKeys;
