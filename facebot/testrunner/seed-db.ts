/// <reference types="node" />
import fs from 'fs';
import { Pool } from 'pg';

interface Chatbase {
  pool: Pool;
}

interface Survey {
  custom_messages?: Record<string, any>;
}

async function getUserId(pool: Pool): Promise<string> {
  const {rows} = await pool.query(`INSERT INTO users(email) VALUES($1) ON CONFLICT(email) DO UPDATE SET email=$1 RETURNING id;`, ['test@test.com']);
  return rows[0].id;
}

async function pages(pool: Pool, userid: string): Promise<void> {
  const pageid = '935593143497601';
  const token = 'test';
  const query = `INSERT INTO credentials(userid, entity, key, details) VALUES($1, $2, $3, $4) ON CONFLICT DO NOTHING`;
  await pool.query(query, [userid, 'facebook_page', pageid, JSON.stringify({token, id: pageid, name: 'Test Page'})]);
}

// WhatsApp Business phone-number-id used across the WhatsApp e2e tests. It is
// both the seeded credential id and the account_id the mox builders stamp.
export const WHATSAPP_PHONE_NUMBER_ID = '106540352242922';

async function whatsapp(pool: Pool, userid: string): Promise<void> {
  const token = 'test';
  // First-class WhatsApp credential: entity='whatsapp_business' with
  // key = phone_number_id (credentials.key holds the platform account id;
  // uniqueness across platforms enforced by the unique_messaging_account
  // partial index — see devops/migrations/20-messaging-account-unique.sql).
  // Consumers resolve it via (entity, key) when platform is known, or
  // key + entity IN (...) otherwise.
  const query = `INSERT INTO credentials(userid, entity, key, details) VALUES($1, $2, $3, $4) ON CONFLICT DO NOTHING`;
  await pool.query(query, [userid, 'whatsapp_business', WHATSAPP_PHONE_NUMBER_ID, JSON.stringify({token, id: WHATSAPP_PHONE_NUMBER_ID, name: 'Test WhatsApp'})]);
}

// --- Media handle fixture (planning/media-abstraction.md §5, §10 section 4) ---
//
// The handle key is (asset_id, account_id) with NO platform component, so the
// account_id below MUST be the very same platform account id the rest of this
// file seeds credentials for — the facebook page id for Messenger sends and the
// whatsapp phone_number_id for WhatsApp sends. If they ever drift apart every
// lookup misses, and a miss is not an error: it is the designed URL fallback.
// The suite would stay green while the handle layer quietly did nothing, which
// is exactly the silent-failure trap migration 24 is written to avoid.
//
// UUIDs are fixed (not generated) so forms/media*.json can hard-code the exact
// public URL of each asset.
export const MEDIA_ASSET_MESSENGER_HANDLE = '11111111-1111-4111-8111-111111111111';
export const MEDIA_ASSET_WHATSAPP_HANDLE = '22222222-2222-4222-8222-222222222222';
export const MEDIA_ASSET_NO_HANDLE = '33333333-3333-4333-8333-333333333333';

// The platform media ids the seeded handles carry. Tests assert on these exact
// strings — that is what proves a send went out by id rather than by URL.
export const MESSENGER_PLATFORM_MEDIA_ID = '900000000000001';
export const WHATSAPP_PLATFORM_MEDIA_ID = '900000000000002';

// The legacy Messenger attachment id embedded in forms/mediaLegacyId.json.
export const LEGACY_ATTACHMENT_ID = '1434849748462496';

// Public base for asset URLs. Deliberately a production-looking host that no
// test container serves: ParseAssetID is host-independent by design, and nothing
// in the message pipeline ever fetches these bytes (see §10 — no MinIO here).
export const MEDIA_PUBLIC_BASE = 'https://media.vlab.digital/a';
export const THIRD_PARTY_MEDIA_URL = 'https://i.imgur.com/ZSHauqq.png';

const FACEBOOK_PAGE_ID = '935593143497601';

// Asset URL exactly as a form fixture spells it, so tests assert the by-URL
// cases against one source of truth rather than a re-typed string.
export function assetUrl(assetId: string, filename: string): string {
  return `${MEDIA_PUBLIC_BASE}/${assetId}/${filename}`;
}

export const MEDIA_URL_MESSENGER_HANDLE = assetUrl(MEDIA_ASSET_MESSENGER_HANDLE, 'messenger-handled.png');
export const MEDIA_URL_WHATSAPP_HANDLE = assetUrl(MEDIA_ASSET_WHATSAPP_HANDLE, 'whatsapp-handled.png');
export const MEDIA_URL_NO_HANDLE = assetUrl(MEDIA_ASSET_NO_HANDLE, 'no-handle.png');

async function media(pool: Pool, userid: string): Promise<void> {
  const assets: [string, string][] = [
    [MEDIA_ASSET_MESSENGER_HANDLE, 'messenger-handled.png'],
    [MEDIA_ASSET_WHATSAPP_HANDLE, 'whatsapp-handled.png'],
    [MEDIA_ASSET_NO_HANDLE, 'no-handle.png'],
  ];

  for (const [id, filename] of assets) {
    await pool.query(
      `INSERT INTO media_asset(id, userid, content_hash, media_type, mime_type, byte_size, filename)
       VALUES($1, $2, $3, 'image', 'image/png', 1234, $4)
       ON CONFLICT (id) DO NOTHING`,
      [id, userid, `hash-${id}`, filename],
    );
  }

  // Messenger handle: expires_at NULL — no known expiry (migration 24).
  await pool.query(
    `INSERT INTO media_handle(asset_id, account_id, platform, platform_media_id, expires_at)
     VALUES($1, $2, 'messenger', $3, NULL)
     ON CONFLICT (asset_id, account_id) DO UPDATE SET platform_media_id = EXCLUDED.platform_media_id`,
    [MEDIA_ASSET_MESSENGER_HANDLE, FACEBOOK_PAGE_ID, MESSENGER_PLATFORM_MEDIA_ID],
  );

  // WhatsApp handle: 30 days out, comfortably outside MEDIA_HANDLE_MARGIN, so
  // Resolve returns ByID rather than degrading on the expiry branch.
  await pool.query(
    `INSERT INTO media_handle(asset_id, account_id, platform, platform_media_id, expires_at)
     VALUES($1, $2, 'whatsapp', $3, now() + INTERVAL '30 days')
     ON CONFLICT (asset_id, account_id) DO UPDATE SET
       platform_media_id = EXCLUDED.platform_media_id,
       expires_at = EXCLUDED.expires_at`,
    [MEDIA_ASSET_WHATSAPP_HANDLE, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_PLATFORM_MEDIA_ID],
  );

  // MEDIA_ASSET_NO_HANDLE deliberately gets no handle row on either account.
}

async function reloadly(pool: Pool, userid: string): Promise<void> {
  const pageid = '935593143497601';
  const query = `INSERT INTO credentials(userid, entity, key, details) VALUES($1, $2, $3, $4) ON CONFLICT DO NOTHING`;
  await pool.query(query, [userid, 'reloadly', pageid, JSON.stringify({
    "id": process.env.RELOADLY_ID, 
    "secret": process.env.RELOADLY_SECRET
  })]);
}

async function insertSurvey(pool: Pool, filename: string, body: string, userid: string, shortcode?: string): Promise<void> {
  const query = `INSERT INTO surveys(created, formid, form, messages, shortcode, userid, title, translation_conf)
       values($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (userid, shortcode) DO UPDATE SET
         form = EXCLUDED.form,
         messages = EXCLUDED.messages,
         translation_conf = EXCLUDED.translation_conf,
         formid = EXCLUDED.formid
       RETURNING *`;

  const form: Survey = JSON.parse(body);
  const messages = form.custom_messages || {};
  const created = new Date();
  const formid = filename.split('.')[0];

  shortcode = shortcode || formid;

  const values = [created, formid, JSON.stringify(form), JSON.stringify(messages), shortcode, userid, '', {}];
  await pool.query(query, values);
}

function readForm(form: string): [string, string] {
  return [form, fs.readFileSync(`forms/${form}`, 'utf8')];
}

export async function seed(chatbase: Chatbase): Promise<void> {
  const pool = chatbase.pool;

  const userId = await getUserId(pool);
  await pages(pool, userId);
  await whatsapp(pool, userId);
  await reloadly(pool, userId);
  await media(pool, userId);

  const inserts = fs.readdirSync('forms')
    .map((form: string) => readForm(form))
    .map(([form, body]: [string, string]) => insertSurvey(pool, form, body, userId));

  await Promise.all(inserts).catch(err => {
    console.error(err);
  });
} 