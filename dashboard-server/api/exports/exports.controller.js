'use strict';
const crypto = require('crypto');
const { Exports } = require('../../queries');
const { KafkaUtil } = require('../../utils');
const { EXPORTS_TOPIC } = require('../../config').KAFKA;

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

// Creates a message on Kafka that will start an export.
// The dashboard-server generates a UUID, inserts the initial "Started" row,
// then publishes the Kafka message with the export_id so the exporter
// can UPDATE that row on completion.
exports.generateExport = async (req, res) => {
  const { survey } = req.query;
  const { export_type, ...options } = req.body;

  const { email } = req.user;
  const source = export_type === 'chat_log' ? 'chat_log' : 'responses';
  const exportId = crypto.randomUUID();

  try {
    // 1. Insert "Started" row so the user sees it immediately
    await Exports.insert(exportId, email, survey, source);

    // 2. Publish Kafka message with the export_id
    const producer = KafkaUtil.Conn.producer({
      createPartitioner: KafkaUtil.Partitioners.DefaultPartitioner
    });
    await producer.connect();
    const message = {
      event: 'data-export',
      user: email,
      survey: survey,
      export_id: exportId,
      source: source,
      ...(source === 'chat_log'
        ? { chat_log_options: options }
        : { options: options })
    };

    await producer.send({
      topic: EXPORTS_TOPIC,
      messages: [{ key: survey, value: JSON.stringify(message) }],
    });
    await producer.disconnect();
    return res.status(201).send({ status: 'success', export_id: exportId });
  } catch (err) {
    handle(err, res);
  }
};
