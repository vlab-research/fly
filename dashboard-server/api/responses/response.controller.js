'use strict';
const { Readable } = require('stream');

const { Response } = require('../../queries');
const { ResponseUtil, KafkaUtil } = require('../../utils');

function handle(err, res) {
  console.error(err);
  res.status(500).end();
}


exports.getAll = async (req, res) => {
  try {
    const { survey, after, pageSize } = req.query;
    const { email } = req.user;

    if (!email) {
      return res.status(400).send({ error: {message: 'No user, no responses!'}});
    }

    if (!survey) {
      return res.status(400).send({ error: {message: 'No user, no responses!'}});
    }

    const responses = await Response.all(email, survey, after, pageSize);
    res.status(200).send(responses);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: {message: err}});
  }
};

function handleCsvResponse(dataStream, filename, res) {
  res.header('Content-Type', 'text/csv');
  res.header(
    'Content-Disposition',
    `attachment; filename="${filename}_${new Date().toISOString()}.csv"`,
  );

  res.status(200);

  const csv = ResponseUtil.toCSV();

  csv.on('error', err => handle(err, res));
  dataStream.on('error', err => handle(err, res));

  dataStream.pipe(csv).pipe(res);
}

exports.getResponsesCSV = async (req, res) => {
  const { survey } = req.query;
  const { email } = req.user;
  try {
    const responseStream = await Response.formResponses(
      email,
      decodeURIComponent(survey),
    );
    handleCsvResponse(responseStream, 'responses', res);
  } catch (err) {
    handle(err, res);
  }
};

// TODO: move to surveys route...
exports.getFormDataCSV = async (req, res) => {
  const { survey } = req.query;
  const { email } = req.user;

  try {
    const data = await Response.formData(email, decodeURIComponent(survey));
    const dataStream = Readable.from(data);
    handleCsvResponse(dataStream, survey, res);
  } catch (err) {
    handle(err, res);
  }
};



exports.generateExport = async (req, res) => {
  const { survey, type } = req.query;
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
      options: {
        type: type
      }
    }

    await producer.send({
      topic: "vlab-exports",
      messages: [{key: "data-exports", value: JSON.stringify(message)}],
    })
    await producer.disconnect()
    return res.status(200).send({status: "success"})
  } catch (err) {
    handle(err, res);
  }
};
