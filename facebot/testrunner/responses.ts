import { Pool } from 'pg';

interface Chatbase {
  pool: Pool;
}

interface Response {
  userid: string;
  timestamp: Date;
  [key: string]: any;
}

interface State {
  userid: string;
  [key: string]: any;
}

export async function getResponses(chatbase: Chatbase, userid: string): Promise<Response[]> {
  const {rows} = await chatbase.pool.query('SELECT * FROM responses WHERE userid=$1 ORDER BY timestamp ASC', [userid]);
  return rows;
}

export async function getState(chatbase: Chatbase, userid: string): Promise<State | undefined> {
  const {rows} = await chatbase.pool.query('SELECT * FROM states WHERE userid=$1', [userid]);
  return rows[0];
} 