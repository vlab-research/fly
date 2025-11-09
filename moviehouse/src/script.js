'use strict';
/* global Sentry, MessengerExtensions, Vimeo */

const SERVER_URL = '{{{SERVER_URL}}}';

// make params dissapear after getting them
const params = getQueryParams()
const videoId = params['id'];
const pageId = params['pageId'];
const userId = params['userId'];
const useExtensions = params['useExtensions'] === 'true';

Sentry.init({ dsn: 'https://17c9ad73343d4a15b8e155a722224374@sentry.io/2581797' });

function getQueryParams() {
  const obj = {}
  const url = new URL(window.location)
  url.searchParams.forEach((v, k) => {
    obj[k] = v
  })

  window.history.replaceState({}, document.title, url.pathname)
  return obj
}

function handleEvent(psid, eventType) {
  return function sendEvent(data) {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', SERVER_URL);
    xhr.setRequestHeader('Content-Type', 'application/json');

    // add ID of video to event...
    xhr.send(JSON.stringify({ user: psid, page: pageId, data, event: { type: 'external', value: { type: `moviehouse:${eventType}`, id: videoId } } }));
  }
}

function handleError(err, title, message) {
  const div = document.createElement('div');
  div.classList.add("error-container");
  div.innerHTML = `<h1>${title}</h1><p>${message}</p>`;
  document.querySelector('.container').innerHTML = ``
  document.querySelector('.container').appendChild(div);
  console.error(err);
  throw err;
}

function setPlayer(psid) {
  const options = {
    id: videoId,
    responsive: true
  };

  const player = new Vimeo.Player('vimeoVideo', options);

  player.ready().then(() => {
    player.on('ended', handleEvent(psid, 'ended'));

    player.on('error', handleEvent(psid, 'error'));

    player.on('pause', handleEvent(psid, 'pause'));

    player.on('play', handleEvent(psid, 'play'));

    player.on('playbackratechange', handleEvent(psid, 'playbackratechange'));

    player.on('seeked', handleEvent(psid, 'seeked'));

    player.on('volumechange', handleEvent(psid, 'volumechange'));

  }).catch((err) => {
    const title = '❌ Not found';
    const message = 'Sorry, we couldn’t find that video'
    handleError(err, title, message);
  });
}

function initMessenger() {

  // just for the heck of it, run in parallel
  MessengerExtensions.getSupportedFeatures(function success(result) {
    const features = result.supported_features;

    if (features.indexOf("context") === -1) {
      console.error(`context is not a support feature. Supported features: ${features}`)
    }
  }, function error(err) {
    console.error(`Error getting supported features: ${err}`)
  });


  MessengerExtensions.getContext('{{{APP_ID}}}',
    function success(thread_context) {
      setPlayer(thread_context.psid);
    },
    function error(err) {
      let title, message;

      switch (err) {
        case 2071010:
          title = '❌ Browser version error';
          message = 'Sorry, we cannot show you this video. It is only visible for study participants. Potentially, your browser or version of Messenger is too old and does not support viewing these videos. You can update your version of Messenger or view it on messenger.com via a modern web browser.';
          break;
        case 2071011:
          title = '🔒Forbidden';
          message = 'This video is only visible for study participants. You must view this page within a Messenger conversation in the Messenger application (either via a browser at messenger.com or within the mobile app "Messenger"). If you are viewing this page in Messenger, you might need a newer version of the Messenger app to view this video. You can also view it on messenger.com via a modern web browser.';
          break;
        default:
          title = '❌ Unknown browser error';
          message = 'We could not display this page in your browser. Please try again in a few hours or days.';
      }

      handleError(new Error(err), title, message);
    }
  );
};

function validateRequiredParams() {
  const missing = [];
  if (!videoId) missing.push('id');
  if (!pageId) missing.push('pageId');
  if (!userId) missing.push('userId');

  if (missing.length > 0) {
    const title = '❌ Missing Parameters';
    const message = `Required parameters are missing: ${missing.join(', ')}. Please make sure you opened this link correctly.`;
    handleError(new Error('Missing parameters'), title, message);
    return false;
  }
  return true;
}

document.addEventListener('DOMContentLoaded', () => {
  if (useExtensions) {
    // Use Messenger Extensions to get user context
    window.extAsyncInit = initMessenger;
  } else {
    // Direct mode: validate required parameters and load player
    if (validateRequiredParams()) {
      setPlayer(userId);
    }
  }
});
