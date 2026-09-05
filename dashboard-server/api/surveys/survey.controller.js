'use strict';

const { Survey } = require('../../queries');
const { registerSurveyVersion, NO_TYPEFORM_CREDENTIAL } = require('./survey.service');

// Guards the ::UUID cast in Survey.update, which would otherwise 500 on junk.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

exports.postOne = async (req, res) => {
  try {
    // add more keys
    const { survey_name, formid, title, shortcode, metadata, translation_conf } = req.body;
    const { email } = req.user;

    if (!(email && formid && shortcode && survey_name)) {
      return res
        .status(400)
        .send(
          `Missing shit!: formid: ${formid}, shortcode: ${shortcode}`,
        );
    }

    const result = await registerSurveyVersion({
      email,
      formid,
      shortcode,
      survey_name,
      title,
      metadata,
      translation_conf,
    });

    if (result.noAccount) {
      return res.status(404).json({ error: `User ${email} does not exist!` });
    }

    if (result.missingCredential) {
      return res.status(400).send(NO_TYPEFORM_CREDENTIAL);
    }

    res.status(201).send(result.survey);
  } catch (err) {
    // A SurveyFailure is the caller's own bad input and its message is safe to
    // return; anything else is ours and must not be echoed.
    if (err && err.expected) {
      console.error(err.message);
      return res.status(400).send(err.message);
    }

    console.error(err);
    res.status(500).send(err);
  }
};

exports.getAll = async (req, res) => {
  try {
    const { email } = req.user;

    if (!email) {
      return res.status(400).send('No user, no survey!');
    }

    const surveys = await Survey.retrieve({ email });

    res.status(200).send(surveys);
  } catch (err) {
    console.error(err);
    res.status(500).send(err);
  }
};


exports.putSettings = async (req, res) => {
  try {
    const { email } = req.user;

    if (!email) {
      return res.status(400).send('No user!');
    }

    const { surveyid } = req.params;
    const { timeouts, off_time } = req.body;

    if (!UUID.test(surveyid)) {
      return res.status(404).json({ error: 'No such survey.' });
    }

    const settings = await Survey.update({ surveyid, email, timeouts, off_time })

    // 404, not 403: a survey that is not yours and a survey that does not exist
    // are the same answer, so this never confirms someone else's survey id.
    if (!settings) {
      return res.status(404).json({ error: 'No such survey.' });
    }

    res.status(200).send(settings);

  } catch (err) {
    console.error(err);
    res.status(500).send(err);
  }
};
