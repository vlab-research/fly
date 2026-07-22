import api from '../../services/api';

// Messaging accounts that can own message templates: Facebook Pages
// (Messenger) and WhatsApp Business numbers. Both are keyed by their Meta
// account id (page id / phone_number_id) — the same id stored in
// message_templates.account_id.
const whatsAppLabel = (cred) => {
  const details = cred.details || {};
  return details.display_phone_number
    ? `WhatsApp ${details.display_phone_number}`
    : `WhatsApp ${cred.key}`;
};

const fetchMessagingAccounts = async () => {
  const [pagesRes, credsRes] = await Promise.all([
    api.fetcher({ path: '/media/pages' }),
    api.fetcher({ path: '/credentials' }),
  ]);
  const [pages, creds] = await Promise.all([pagesRes.json(), credsRes.json()]);
  const messenger = (Array.isArray(pages) ? pages : [])
    .map(p => ({ id: p.id, name: p.name, platform: 'messenger' }));
  const whatsapp = (Array.isArray(creds) ? creds : [])
    .filter(c => c.entity === 'whatsapp_business')
    .map(c => ({ id: c.key, name: whatsAppLabel(c), platform: 'whatsapp' }));
  return [...messenger, ...whatsapp];
};

export default fetchMessagingAccounts;
