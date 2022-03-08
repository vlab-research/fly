const translateShortText = data => {
  return { text: data.title };
};

//welcome_screen
const translateWelcomeScreen = (data, ref) => {
  const text = data.properties.button_text;
  return makeMultipleChoice(data.title, [{ label: text }], ref);
};

const translateLongText = translateShortText;
const translateNumber = translateShortText;
const translateDate = translateShortText;

const translateStatement = data => {
  const response = translateShortText(data);
  response.metadata = { type: "statement" };
  return response;
};

const translateThankYouScreen = data => {
  const title = data.title.split("\n")[0];
  const response = translateShortText({ title });
  response.metadata = { type: "thankyou_screen" };
  return response;
};

const makeMultipleChoice = (text, choices, ref) => {
  // let's try multiple elements??
  const response = { text };

  response.quick_replies = choices.map(choice => {
    const [title, value] = Array.isArray(choice)
      ? choice
      : [choice.label, choice.label];
    return {
      content_type: "text",
      title: title,
      payload: JSON.stringify({ value, ref }),
    };
  });

  return response;
};

const _makeSimpleChoice = (text, choices, ref) => {
  const response = {};
  const buttons = choices.map(choice => {
    // use choice.id for multiple choice??
    const [title, value] = Array.isArray(choice)
      ? choice
      : [choice.label, choice.label];

    return {
      type: "postback",
      title: title,
      payload: JSON.stringify({ value: value, ref: ref }),
    };
  });
  response.attachment = {
    type: "template",
    payload: {
      template_type: "button",
      text: text,
      buttons,
    },
  };
  return response;
};

//multiple_choice
const translateMultipleChoice = (data, ref) => {
  return makeMultipleChoice(data.title, data.properties.choices, ref);
};

const translateDropDown = translateMultipleChoice;

//yes_no to quick reply
const translateYesNo = (data, ref) => {
  return _makeSimpleChoice(
    data.title,
    [
      ["Yes", true],
      ["No", false],
    ],
    ref
  );
};

//email to quick reply (fb has qr button for sending email assoc with account)
const translateEmail = data => {
  const response = translateShortText(data);
  response.quick_replies = [
    {
      content_type: "user_email",
    },
  ];
  return response;
};

const translatePhone = data => {
  const response = translateShortText(data);
  response.quick_replies = [
    {
      content_type: "user_phone_number",
    },
  ];
  return response;
};

const translateRatings = (data, ref) => {
  const start = data.properties.start_at_one === false ? 0 : 1;
  const steps = data.properties.steps;

  const choices = new Array(steps)
    .fill("*")
    .map((e, i) => ({ label: `${i + start}` }));

  return makeMultipleChoice(data.title, choices, ref);
};

//opinion scale to quick reply
const translateOpinionScale = translateRatings;

//transform to carousel of generic templates
const translatePictureChoice = data => {
  const response = {};
  const elements = data.properties.choices.map(choice => {
    const buttons = [
      {
        type: "postback",
        title: `select ${choice.label}`,
        payload: choice.label,
      },
    ];
    return {
      title: data.title,
      image_url: choice.attachment.href,
      buttons,
    };
  });
  response.attachment = {
    type: "template",
    payload: {
      template_type: "generic",
      elements,
    },
  };
  return response;
};

function _shareButton(shareText, buttonText, url) {
  return {
    type: "element_share",
    share_contents: {
      attachment: {
        type: "template",
        payload: {
          template_type: "generic",
          elements: [
            {
              title: shareText || "Take this survey",
              // "subtitle": "<TEMPLATE_SUBTITLE>",
              // "image_url": "<IMAGE_URL_TO_DISPLAY>",
              default_action: {
                type: "web_url",
                url: url,
              },
              buttons: [
                {
                  type: "web_url",
                  url: url,
                  title: buttonText || "Start",
                },
              ],
            },
          ],
        },
      },
    },
  };
}

const translateShare = data => {
  const { url, shareText, buttonText } = data.md;

  const response = {
    attachment: {
      type: "template",
      payload: {
        template_type: "button",
        text: data.title,
        buttons: [_shareButton(shareText, buttonText, url)],
      },
    },
  };

  return response;
};

const translateWait = translateShortText;
const translateStitch = translateShortText;

const translateNotify = (data, ref) => {
  const response = {
    attachment: {
      type: "template",
      payload: {
        template_type: "one_time_notif_req",
        title: data.title,
        payload: JSON.stringify({ ref }),
      },
    },
  };

  return response;
};

const makeUrl = url => {
  if (typeof url === "string") {
    return url;
  }

  const { base, protocol = "https", params = {} } = url;

  if (!base) {
    throw new Error(`Invalid URL object for creating a URL: ${url}`);
  }

  const p = new URLSearchParams(params);
  const b = new URL(`${protocol}://${base}`);
  b.search = p.toString();
  return b.href;
};

const translateWebview = data => {
  const { url, buttonText, extensions } = data.md;

  const response = {
    attachment: {
      type: "template",
      payload: {
        template_type: "button",
        text: data.title,
        buttons: [
          {
            type: "web_url",
            url: makeUrl(url),
            title: buttonText || "View website",
            webview_height_ratio: "full",
            // default extensions to true
            messenger_extensions: extensions === undefined ? true : extensions,
          },
        ],
      },
    },
  };
  return response;
};

const translateAttachment = data => {
  const { attachment } = data.md;
  const { type, url } = attachment;

  const response = {
    attachment: {
      type: type,
      payload: {
        url: url,
        is_reusable: true,
      },
    },
  };
  return response;
};

const lookup = {
  short_text: translateShortText,
  multiple_choice: translateMultipleChoice,
  email: translateEmail,
  phone_number: translatePhone,
  picture_choice: translatePictureChoice,
  long_text: translateLongText,
  welcome_screen: translateWelcomeScreen,
  thankyou_screen: translateThankYouScreen,
  yes_no: translateYesNo,
  number: translateNumber,
  statement: translateStatement,
  opinion_scale: translateOpinionScale,
  rating: translateRatings,
  share: translateShare,
  webview: translateWebview,
  wait: translateWait,
  stitch: translateStitch,
  notify: translateNotify,
  attachment: translateAttachment,
};

function translator(question) {
  const fn = lookup[question.type];

  if (!fn) {
    throw new TypeError(
      `There is no translator for the question of type ${question.type}`
    );
  }
  const response = fn(question, question.ref);

  response.metadata = JSON.stringify({
    ...response.metadata,
    ...question.md,
    ref: question.ref,
  });

  return response;
}

module.exports = {
  translator,
  translateWelcomeScreen,
  translateThankYouScreen,
  translateShortText,
  translateLongText,
  translateNumber,
  translateStatement,
  translateYesNo,
  translateMultipleChoice,
  translateDropDown,
  translateEmail,
  translateOpinionScale,
  translateRatings,
  translatePictureChoice,
  translateDate,
  makeUrl,
};
