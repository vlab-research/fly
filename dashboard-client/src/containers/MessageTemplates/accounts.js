import api from '../../services/api';

// Messaging accounts that can own message templates: Facebook Pages
// (Messenger) and WhatsApp Business numbers. Both are keyed by their Meta
// account id (page id / phone_number_id) — the same id stored in
// message_templates.account_id.
//
// Both come from /credentials. This used to fetch the Messenger half from
// /media/pages, which was deleted along with the media page selector
// (planning/media-abstraction.md §3 — media asset creation is
// platform-independent, so there is no page for an author to choose). That
// endpoint was never about media anyway; it was a credentials listing that
// happened to live under /media, and message templates were its only remaining
// caller.
const whatsAppLabel = (cred) => {
  const details = cred.details || {};
  return details.display_phone_number
    ? `WhatsApp ${details.display_phone_number}`
    : `WhatsApp ${cred.key}`;
};

// `key` rather than details.id: it is the id message_templates.account_id
// stores, and the one the server keys everything else on.
const messengerLabel = (cred) => (cred.details || {}).name || cred.key;

const fetchMessagingAccounts = async () => {
  const credsRes = await api.fetcher({ path: '/credentials' });
  const creds = await credsRes.json();
  const all = Array.isArray(creds) ? creds : [];

  const messenger = all
    .filter(c => c.entity === 'facebook_page')
    .map(c => ({ id: c.key, name: messengerLabel(c), platform: 'messenger' }));
  const whatsapp = all
    .filter(c => c.entity === 'whatsapp_business')
    .map(c => ({ id: c.key, name: whatsAppLabel(c), platform: 'whatsapp' }));

  return [...messenger, ...whatsapp];
};

export default fetchMessagingAccounts;
