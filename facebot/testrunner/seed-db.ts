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
  // The message-worker token store resolves access tokens via the
  // facebook_page_id computed column, which is only populated for
  // entity='facebook_page' (details->>'id'). Seed the WhatsApp phone-number-id
  // token the same way so GetToken(phone_number_id) resolves it. (A dedicated
  // whatsapp_business credential type is a production concern, deferred.)
  const query = `INSERT INTO credentials(userid, entity, key, details) VALUES($1, $2, $3, $4) ON CONFLICT DO NOTHING`;
  await pool.query(query, [userid, 'facebook_page', WHATSAPP_PHONE_NUMBER_ID, JSON.stringify({token, id: WHATSAPP_PHONE_NUMBER_ID, name: 'Test WhatsApp'})]);
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

  const inserts = fs.readdirSync('forms')
    .map((form: string) => readForm(form))
    .map(([form, body]: [string, string]) => insertSurvey(pool, form, body, userId));

  await Promise.all(inserts).catch(err => {
    console.error(err);
  });
} 