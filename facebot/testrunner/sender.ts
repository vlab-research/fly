import r2 from 'r2';

const BOTSERVER_URL = process.env.BOTSERVER_URL || 'http://localhost:3000';

interface Message {
  source: 'synthetic' | string;
  [key: string]: any;
}

interface Response {
  body?: {
    error?: string;
  };
}

const sendMessage = async function (message: Message): Promise<Response> {
  let json: any;
  let url: string;
  const {source} = message;

  switch (source) {
    case 'synthetic':
      url = `${BOTSERVER_URL}/synthetic`;
      json = message;
      break;

    default:
      url = `${BOTSERVER_URL}/webhooks`;
      json = { entry: [message] };
  }

  const res = await r2.post(url, { json }).response;

  if (res.body && res.body.error) {
    throw new Error(res.body.error);
  }
  return res;
};

export default sendMessage; 