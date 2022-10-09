const router = require('express').Router();
const { AuthUtil } = require('../../utils');
const { makeAPIToken, insertIntoCredentials } = AuthUtil;


async function createApiToken(req, res) {
  const { email } = req.user;
  const { name } = req.body;

  const token = await makeAPIToken(
    {
      email,
      'https://vlab.digital/token-name': name
    }
  )

  try {
    const cred = await insertIntoCredentials(email, name)
    res.status(201).json({ name: cred.details.name, token })
  } catch (e) {

    if (e.code === '23505') {
      res.status(400).json({ error: 'Sorry, there is already an API Key with that name' })
    } else {
      res.status(500).json({ error: e })
    }
  }

}

async function revokeApiToken(req, res) {
  // const { email } = req.user;
  const { token } = req.query;

  // get name out of token
  // mark revoked in database

  res.status(200).json({ token })

  // place into database in list of revoked tokens...
  // then check that list on auth...
  // preferably with a cache
}

router.post('/api-token', createApiToken);
router.delete('/api-token', revokeApiToken);

module.exports = router;
