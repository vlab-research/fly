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

async function reloadly(pool: Pool, userid: string): Promise<void> {
  const pageid = '935593143497601';
  const query = `INSERT INTO credentials(userid, entity, key, details) VALUES($1, $2, $3, $4) ON CONFLICT DO NOTHING`;
  await pool.query(query, [userid, 'reloadly', pageid, JSON.stringify({
    "id": process.env.RELOADLY_ID, 
    "secret": process.env.RELOADLY_SECRET
  })]);
}

async function surveyExists(pool: Pool, userid: string, shortcode: string): Promise<boolean> {
  const query = `SELECT id from surveys where userid = $1 and shortcode = $2;`;
  const {rows} = await pool.query(query, [userid, shortcode]);
  return !!rows && !!rows.length;
}

async function insertSurvey(pool: Pool, filename: string, body: string, userid: string, shortcode?: string): Promise<void> {
  const query = `INSERT INTO surveys(created, formid, form, messages, shortcode, userid, title, translation_conf)
       values($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`;

  const form: Survey = JSON.parse(body);
  const messages = form.custom_messages || {};
  const created = new Date();
  const formid = filename.split('.')[0];

  shortcode = shortcode || formid;

  const exists = await surveyExists(pool, userid, shortcode);
  if (exists) return;

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
  await reloadly(pool, userId);

  const inserts = fs.readdirSync('forms')
    .map((form: string) => readForm(form))
    .map(([form, body]: [string, string]) => insertSurvey(pool, form, body, userId));

  await Promise.all(inserts).catch(err => {
    console.error(err);
  });
} 