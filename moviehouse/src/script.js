'use strict';
/* global Sentry, MessengerExtensions, Vimeo, MoviehouseIdentity */

const SERVER_URL = '{{{SERVER_URL}}}';
const HEARTBEAT_INTERVAL_MS = parseInt('{{{HEARTBEAT_INTERVAL_MS}}}', 10) || 30000;

// make params dissapear after getting them
const params = getQueryParams()

// Everything this page needs is resolved through the pure core, which reads the
// canonical `vlab_*` names first and falls back to the legacy ones for URLs that
// were already delivered to participants. Nothing here indexes a query param
// directly any more -- that is what let `id` mean two different things.
const videoId = MoviehouseIdentity.resolveVideoId(params);
const userId = MoviehouseIdentity.resolveUser(params);
const useExtensions = params['useExtensions'] === 'true';

// The conversation this page's events belong to, resolved once from the query
// string. Every /synthetic POST must carry the triple
// (platform, account_id, user_id) -- see ../documentation/event-envelope.md.
// A `moviehouse` field gets all three for free: replybot builds the URL.
const conversation = MoviehouseIdentity.resolveConversation(params);

// Logged ONCE per page load, not once per event: a heartbeat every 30 seconds
// plus play/pause/seek would otherwise flood the console for a single watcher.
if (conversation.invalidPlatform) {
  console.warn(`[MOVIEHOUSE_PLATFORM_INVALID] video=${videoId} account=${conversation.account_id} platform="${conversation.invalidPlatform}" -- not a known platform, sending none`);
}

if (conversation.missing.length > 0) {
  console.warn(`[MOVIEHOUSE_CONVERSATION_INCOMPLETE] video=${videoId} account=${conversation.account_id} missing: ${conversation.missing.join(', ')} -- change the survey field's type to 'moviehouse' so replybot builds this url`);
}

// Heartbeat state
let heartbeatInterval = null;
let currentPlayer = null;
let currentPsid = null;

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

// The only place moviehouse talks to hermes. Body construction is pure
// (identity.js buildSyntheticBody); this is the IO.
function postEvent(psid, eventType, data) {
  const body = MoviehouseIdentity.buildSyntheticBody({
    user: psid,
    conversation: conversation,
    videoId: videoId,
    eventType: eventType,
    data: data
  });

  const xhr = new XMLHttpRequest();
  xhr.open('POST', SERVER_URL);
  xhr.setRequestHeader('Content-Type', 'application/json');
  xhr.send(JSON.stringify(body));
}

function handleEvent(psid, eventType) {
  return function sendEvent(data) {
    postEvent(psid, eventType, data);
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

async function sendHeartbeat() {
  if (!currentPlayer || !currentPsid) return;

  try {
    const currentTime = await currentPlayer.getCurrentTime();
    postEvent(currentPsid, 'heartbeat', { currentTime: currentTime });
  } catch (err) {
    console.error('Heartbeat error:', err);
  }
}

function startHeartbeat() {
  if (!heartbeatInterval) {
    sendHeartbeat();
    heartbeatInterval = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
  }
}

function stopHeartbeat() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
}

function setPlayer(psid) {
  const options = {
    id: videoId,
    responsive: true
  };

  const player = new Vimeo.Player('vimeoVideo', options);
  currentPlayer = player;
  currentPsid = psid;

  player.ready().then(() => {
    player.on('ended', (data) => {
      handleEvent(psid, 'ended')(data);
      stopHeartbeat();
    });

    player.on('error', handleEvent(psid, 'error'));

    player.on('pause', (data) => {
      handleEvent(psid, 'pause')(data);
      stopHeartbeat();
    });

    player.on('play', (data) => {
      handleEvent(psid, 'play')(data);
      startHeartbeat();
    });

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
}

// The required set is unchanged in substance -- video, account, participant --
// but is now expressed over the RESOLVED values rather than over three literal
// param names, so a legacy `id`/`pageId`/`userId` URL and a canonical
// `vlab_video`/`vlab_account`/`vlab_user` one both satisfy it. The names in the
// error message are the canonical ones, because that is what a researcher
// should end up with.
function validateRequiredParams() {
  const missing = [];
  if (!videoId) missing.push(MoviehouseIdentity.PARAM_VIDEO);
  if (!conversation.account_id) missing.push(MoviehouseIdentity.PARAM_ACCOUNT);
  if (!userId) missing.push(MoviehouseIdentity.PARAM_USER);

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
