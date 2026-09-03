'use strict';

const { Survey, User, Credential } = require('../../queries');
const { SurveyUtil } = require('../../utils');
const { TypeformUtil } = require('../../utils');

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

    // TODO: this is silly, get userid via db query
    const user = await User.user({ email });
    if (!user)
      return res.status(404).json({ error: `User ${email} does not exist!` });
    const { id: userid } = user;

    const cred = await Credential.getOne({ email, entity: 'typeform_token', key: TypeformUtil.makeKey(email) });
    const token = cred.details.access_token;

    const form = await TypeformUtil.TypeformForm(token, formid);
    const messages = await TypeformUtil.TypeformMessages(token, formid);

    // check if translation is possible with formcentral
    const err = await SurveyUtil.validateTranslation({ form, translation_conf })
    if (err) {
      return res.status(400).send('Translation config not valid. Error: ' + err)
    }

    const created = new Date();

    // add good stuff here
    const survey = {
      formid,
      created,
      messages,
      title,
      userid, // TODO: change userid for teamid
      form,
      shortcode,
      survey_name,
      metadata,
      translation_conf,
    };

    SurveyUtil.validate(survey);
    const createdSurvey = await Survey.create(survey);

    res.status(201).send(createdSurvey);
  } catch (err) {
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
