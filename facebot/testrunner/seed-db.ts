/// <reference types="node" />
import fs from 'fs';
import { Pool } from 'pg';

interface Chatbase {
  pool: Pool;
}

interface Survey {
  custom_messages?: Record<string, any>;
}

// --- Conversation identity test fixture: two researchers, four messaging accounts
//
// §A1: To test conversation isolation and cross-researcher containment, we seed two
// distinct researchers (test@test.com and test2@test.com), each owning two messaging
// accounts (Messenger page + WhatsApp phone_number_id). The existing 40 tests depend on
// researcher A's ids and the media fixture's hardcoded page id — so R1's accounts are
// kept byte-identical. Only R2 is new.
//
// §A2: Each account gets a distinct credential token. On Messenger, the token in
// Authorization: Bearer is the ONLY account signal on the outbound wire (no page id in
// URL or body). A distinct token per account is what makes "this send went out on page B"
// assertable in a two-account test.

export const RESEARCHER_A_EMAIL = 'test@test.com';
export const RESEARCHER_B_EMAIL = 'test2@test.com';

export const PAGE_A = '935593143497601';
export const PAGE_B = '811223344556677';

export const WA_A = '106540352242922';
export const WA_B = '107650463353033';

// Keep WHATSAPP_PHONE_NUMBER_ID as an alias of WA_A — mox.ts:3 imports by that name.
export const WHATSAPP_PHONE_NUMBER_ID = WA_A;

// Tokens per account, distinct so the receiver can tell sends apart (A2).
export const ACCOUNT_TOKENS: Record<string, string> = {
  [PAGE_A]: 'tok-page-a',
  [PAGE_B]: 'tok-page-b',
  [WA_A]: 'tok-wa-a',
  [WA_B]: 'tok-wa-b',
};

// Maps from account id to which researcher owns it.
export const ACCOUNT_OWNER: Record<string, 'A' | 'B'> = {
  [PAGE_A]: 'A',
  [PAGE_B]: 'B',
  [WA_A]: 'A',
  [WA_B]: 'B',
};

// Maps from account id to platform.
export const ACCOUNT_PLATFORM: Record<string, 'messenger' | 'whatsapp'> = {
  [PAGE_A]: 'messenger',
  [PAGE_B]: 'messenger',
  [WA_A]: 'whatsapp',
  [WA_B]: 'whatsapp',
};

async function getUserIds(pool: Pool): Promise<{ userIdA: string; userIdB: string }> {
  const resultA = await pool.query(
    `INSERT INTO users(email) VALUES($1) ON CONFLICT(email) DO UPDATE SET email=$1 RETURNING id;`,
    [RESEARCHER_A_EMAIL]
  );
  const userIdA = resultA.rows[0].id;

  const resultB = await pool.query(
    `INSERT INTO users(email) VALUES($1) ON CONFLICT(email) DO UPDATE SET email=$1 RETURNING id;`,
    [RESEARCHER_B_EMAIL]
  );
  const userIdB = resultB.rows[0].id;

  return { userIdA, userIdB };
}

async function pages(pool: Pool, userid: string, pageid: string, token: string): Promise<void> {
  const query = `INSERT INTO credentials(userid, entity, key, details) VALUES($1, $2, $3, $4) ON CONFLICT DO NOTHING`;
  await pool.query(query, [userid, 'facebook_page', pageid, JSON.stringify({token, id: pageid, name: `Test Page ${pageid}` })]);
}

async function whatsapp(pool: Pool, userid: string, phoneNumberId: string, token: string): Promise<void> {
  // First-class WhatsApp credential: entity='whatsapp_business' with
  // key = phone_number_id (credentials.key holds the platform account id;
  // uniqueness across platforms enforced by the unique_messaging_account
  // partial index — see devops/migrations/20-messaging-account-unique.sql).
  // Consumers resolve it via (entity, key) when platform is known, or
  // key + entity IN (...) otherwise.
  const query = `INSERT INTO credentials(userid, entity, key, details) VALUES($1, $2, $3, $4) ON CONFLICT DO NOTHING`;
  await pool.query(query, [userid, 'whatsapp_business', phoneNumberId, JSON.stringify({token, id: phoneNumberId, name: `Test WhatsApp ${phoneNumberId}`})]);
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
//
// Media fixtures are ALWAYS owned by researcher A — they are pinned to PAGE_A and
// WA_A by the test infrastructure (seed-db.ts:100-116 hardcodes them, as does
// mox.ts:9 PAGE_ID). This is intentional: the media tests are not two-account
// tests, and reusing the fixtures under researcher B would break isolation.
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

// Asset URL exactly as a form fixture spells it, so tests assert the by-URL
// cases against one source of truth rather than a re-typed string.
export function assetUrl(assetId: string, filename: string): string {
  return `${MEDIA_PUBLIC_BASE}/${assetId}/${filename}`;
}

export const MEDIA_URL_MESSENGER_HANDLE = assetUrl(MEDIA_ASSET_MESSENGER_HANDLE, 'messenger-handled.png');
export const MEDIA_URL_WHATSAPP_HANDLE = assetUrl(MEDIA_ASSET_WHATSAPP_HANDLE, 'whatsapp-handled.png');
export const MEDIA_URL_NO_HANDLE = assetUrl(MEDIA_ASSET_NO_HANDLE, 'no-handle.png');

async function media(pool: Pool, userIdA: string): Promise<void> {
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
      [id, userIdA, `hash-${id}`, filename],
    );
  }

  // Messenger handle: expires_at NULL — no known expiry (migration 24).
  // Pinned to PAGE_A, researcher A's page.
  await pool.query(
    `INSERT INTO media_handle(asset_id, account_id, platform, platform_media_id, expires_at)
     VALUES($1, $2, 'messenger', $3, NULL)
     ON CONFLICT (asset_id, account_id) DO UPDATE SET platform_media_id = EXCLUDED.platform_media_id`,
    [MEDIA_ASSET_MESSENGER_HANDLE, PAGE_A, MESSENGER_PLATFORM_MEDIA_ID],
  );

  // WhatsApp handle: 30 days out, comfortably outside MEDIA_HANDLE_MARGIN, so
  // Resolve returns ByID rather than degrading on the expiry branch.
  // Pinned to WA_A, researcher A's phone number.
  await pool.query(
    `INSERT INTO media_handle(asset_id, account_id, platform, platform_media_id, expires_at)
     VALUES($1, $2, 'whatsapp', $3, now() + INTERVAL '30 days')
     ON CONFLICT (asset_id, account_id) DO UPDATE SET
       platform_media_id = EXCLUDED.platform_media_id,
       expires_at = EXCLUDED.expires_at`,
    [MEDIA_ASSET_WHATSAPP_HANDLE, WA_A, WHATSAPP_PLATFORM_MEDIA_ID],
  );

  // MEDIA_ASSET_NO_HANDLE deliberately gets no handle row on either account.
}

async function reloadly(pool: Pool, userIdA: string): Promise<void> {
  // Reloadly credential is pinned to PAGE_A, researcher A's page, by design.
  // It is outside the unique_messaging_account predicate (entity != 'facebook_page'
  // and != 'whatsapp_business'), so seeding it under two researchers would not
  // conflict, but it is a one-off test fixture owned by researcher A.
  const query = `INSERT INTO credentials(userid, entity, key, details) VALUES($1, $2, $3, $4) ON CONFLICT DO NOTHING`;
  await pool.query(query, [userIdA, 'reloadly', PAGE_A, JSON.stringify({
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

  const { userIdA, userIdB } = await getUserIds(pool);

  // Researcher A: all accounts, media, reloadly
  await pages(pool, userIdA, PAGE_A, ACCOUNT_TOKENS[PAGE_A]);
  await whatsapp(pool, userIdA, WA_A, ACCOUNT_TOKENS[WA_A]);
  await reloadly(pool, userIdA);
  await media(pool, userIdA);

  // Researcher B: just the messaging accounts, no media or reloadly
  await pages(pool, userIdB, PAGE_B, ACCOUNT_TOKENS[PAGE_B]);
  await whatsapp(pool, userIdB, WA_B, ACCOUNT_TOKENS[WA_B]);

  // Seed forms, with researcher-specific scoping for isolation forms.
  // Existing fixtures all seed under researcher A (40+ tests depend on them).
  // isoFormA seeds under researcher A only.
  // isoFormB seeds under researcher B only — EXCLUDED from bulk seed under A.
  //
  // The exclusion is load-bearing: if isoFormB were also under researcher A,
  // then a leaked state referencing isoFormB would still resolve successfully
  // on researcher A, and the cross-researcher containment test would pass while
  // the leak was live. Only researcher B owns isoFormB, so form B is unreachable
  // from researcher A's accounts, which makes the contamination detectable.

  const formsDir = fs.readdirSync('forms');

  // Bulk seed all existing fixtures under researcher A, excluding isoFormB.
  const inserts = formsDir
    .filter(form => form !== 'isoFormB.json')
    .map((form: string) => readForm(form))
    .map(([form, body]: [string, string]) => insertSurvey(pool, form, body, userIdA));

  await Promise.all(inserts).catch(err => {
    console.error(err);
  });

  // Seed isoFormA under researcher A.
  if (formsDir.includes('isoFormA.json')) {
    const [_, isoFormABody] = readForm('isoFormA.json');
    await insertSurvey(pool, 'isoFormA.json', isoFormABody, userIdA).catch(err => {
      console.error(err);
    });
  }

  // Seed isoFormB under researcher B only.
  if (formsDir.includes('isoFormB.json')) {
    const [_, isoFormBBody] = readForm('isoFormB.json');
    await insertSurvey(pool, 'isoFormB.json', isoFormBBody, userIdB).catch(err => {
      console.error(err);
    });
  }
} 