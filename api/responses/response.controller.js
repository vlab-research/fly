'use strict';

const { Response } = require('../../queries');
const { ResponseUtil } = require('../../utils');

exports.getAll = async (req, res) => {
  try {
    const responses = await Response.all();
    res.status(200).send(responses);
  } catch (err) {
    console.error(err);
    res.status(500).end();
  }
};

exports.getResponsesCSV = async (req, res) => {
  const { formid } = req.params;
  try {
    const responses = await Response.formResponses(formid);

    res.header('Content-Type', 'text/csv');
    res.header(
      'Content-Disposition',
      `attachment; filename="report_${formid}_${new Date().toISOString()}.csv"`,
    );
    res.status(200);

    ResponseUtil.toCSV(responses).pipe(res);
  } catch (err) {
    console.error(err);
    res.status(500).end();
  }
};