'use strict';
const { Exports } = require('../../queries');
const { KafkaUtil } = require('../../utils');

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

// creates a message on Kafka that will start an export
// the job will update the database with the status of the export
exports.generateExport = async (req, res) => {
  const { survey } = req.query;
  const options = req.body;

  const { email } = req.user;

  try {
    const producer = KafkaUtil.Conn.producer({
      createPartitioner: KafkaUtil.Partitioners.DefaultPartitioner
    })
    await producer.connect()
    const message = {
      event: "data-export",
      user: email,
      survey: survey,
      options: options
    }

    await producer.send({
      topic: "vlab-exports",
      messages: [{ key: "data-exports", value: JSON.stringify(message) }],
    })
    await producer.disconnect()
    return res.status(201).send({ status: "success" })
  } catch (err) {
    handle(err, res);
  }
};
