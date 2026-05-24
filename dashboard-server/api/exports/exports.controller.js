'use strict';
const crypto = require('crypto');
const { Exports } = require('../../queries');

function handle(err, res) {
  console.error(err);
  res.status(500).end();
}

exports.getAll = async (req, res) => {
  try {
    const { email } = req.user;

    if (!email) {
      return res.status(400).send('No user, no responses!');
    }

    const responses = await Exports.all(email);
    res.status(200).send(responses.responses);
  } catch (err) {
    console.error(err);
    res.status(500).send(err);
  }
};

exports.getBySurvey = async (req, res) => {
  try {
    const { email } = req.user;
    const { survey } = req.query;

    if (!email) {
      return res.status(400).send('No user, no responses!');
    }

    if (!survey) {
      return res.status(400).send('survey query parameter is required');
    }

    const responses = await Exports.bySurvey(email, survey);
    res.status(200).send(responses.responses);
  } catch (err) {
    console.error(err);
    res.status(500).send(err);
  }
};

exports.generateExport = async (req, res) => {
  const { survey } = req.query;
  const { export_type, ...options } = req.body;

  const { email } = req.user;
  const SOURCE_MAP = { chat_log: 'chat_log', full_messages: 'full_messages' };
  const source = SOURCE_MAP[export_type] || 'responses';
  const exportId = crypto.randomUUID();

  try {
    await Exports.insert(exportId, email, survey, source, options);
    return res.status(201).send({ status: 'success', export_id: exportId });
  } catch (err) {
    handle(err, res);
  }
};
