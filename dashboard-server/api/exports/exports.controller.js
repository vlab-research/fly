'use strict';

const { startExport, listExports } = require('./exports.service');

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

    res.status(200).send(await listExports({ email }));
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

    res.status(200).send(await listExports({ email, survey_name: survey }));
  } catch (err) {
    console.error(err);
    res.status(500).send(err);
  }
};

exports.generateExport = async (req, res) => {
  const { survey } = req.query;
  const { export_type, ...options } = req.body;
  const { email } = req.user;

  try {
    const { export_id } = await startExport({ email, survey_name: survey, export_type, options });
    return res.status(201).send({ status: 'success', export_id });
  } catch (err) {
    handle(err, res);
  }
};
