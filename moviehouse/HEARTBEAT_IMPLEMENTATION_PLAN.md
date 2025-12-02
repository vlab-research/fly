# Moviehouse Heartbeat Implementation Plan

## Overview
Add heartbeat events to track video watch progress. Heartbeats fire every X seconds while the video is **playing**. This allows server-side queries for "last heartbeat per user" to determine watch progress.

## File to Modify
`moviehouse/src/script.js`

---

## Step-by-Step Implementation

### Step 1: Add Heartbeat Configuration

**Location:** After line 4 (after `const SERVER_URL = '{{{SERVER_URL}}}';`)

**Add:**
```js
const HEARTBEAT_INTERVAL_MS = parseInt('{{{HEARTBEAT_INTERVAL_MS}}}', 10) || 30000;
```

**Why:** Allows the heartbeat interval to be configured at deploy time. Falls back to 30 seconds (30000ms) if not set or invalid.

---

### Step 2: Add State Variables

**Location:** After line 11 (after `const userId = params['userId'];`), before `Sentry.init`

**Add:**
```js
// Heartbeat state
let heartbeatInterval = null;
let currentPlayer = null;
let currentPsid = null;
```

**Why:** Module-level variables to track the interval ID and player/user references.

---

### Step 3: Create the sendHeartbeat Function

**Location:** After the `handleError` function (after line 44), before `setPlayer`

**Add:**
```js
async function sendHeartbeat() {
  if (!currentPlayer || !currentPsid) return;

  try {
    const currentTime = await currentPlayer.getCurrentTime();
    const xhr = new XMLHttpRequest();
    xhr.open('POST', SERVER_URL);
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.send(JSON.stringify({
      user: currentPsid,
      page: pageId,
      data: { currentTime: currentTime },
      event: {
        type: 'external',
        value: { type: 'moviehouse:heartbeat', id: videoId }
      }
    }));
  } catch (err) {
    console.error('Heartbeat error:', err);
  }
}
```

**Why:** Queries the Vimeo player for current position and sends a heartbeat event. Includes try/catch to prevent errors from breaking the player.

---

### Step 4: Create startHeartbeat and stopHeartbeat Functions

**Location:** Immediately after the `sendHeartbeat` function

**Add:**
```js
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
```

**Why:** Encapsulates interval management. `startHeartbeat` sends an immediate heartbeat, then continues every X seconds. Guards against duplicate intervals.

---

### Step 5: Modify setPlayer Function

**Location:** Inside the `setPlayer` function

#### 5a: Store player and psid references

**Change line 52 from:**
```js
  const player = new Vimeo.Player('vimeoVideo', options);
```

**To:**
```js
  const player = new Vimeo.Player('vimeoVideo', options);
  currentPlayer = player;
  currentPsid = psid;
```

#### 5b: Add heartbeat start on play event

**Change line 61 from:**
```js
    player.on('play', handleEvent(psid, 'play'));
```

**To:**
```js
    player.on('play', (data) => {
      handleEvent(psid, 'play')(data);
      startHeartbeat();
    });
```

#### 5c: Add heartbeat stop on pause event

**Change line 59 from:**
```js
    player.on('pause', handleEvent(psid, 'pause'));
```

**To:**
```js
    player.on('pause', (data) => {
      handleEvent(psid, 'pause')(data);
      stopHeartbeat();
    });
```

#### 5d: Add heartbeat stop on ended event

**Change line 55 from:**
```js
    player.on('ended', handleEvent(psid, 'ended'));
```

**To:**
```js
    player.on('ended', (data) => {
      handleEvent(psid, 'ended')(data);
      stopHeartbeat();
    });
```

---

## Configuration

Add to your deployment environment/template:

| Variable | Description | Default |
|----------|-------------|---------|
| `HEARTBEAT_INTERVAL_MS` | Milliseconds between heartbeats | `30000` (30s) |

---

## Event Payload Structure

```json
{
  "user": "<psid>",
  "page": "<pageId>",
  "data": {
    "currentTime": 45.23
  },
  "event": {
    "type": "external",
    "value": {
      "type": "moviehouse:heartbeat",
      "id": "<videoId>"
    }
  }
}
```

- `currentTime` is in seconds (float) from Vimeo's `getCurrentTime()` method

---

## Behavior

| Video State | Heartbeats |
|-------------|------------|
| Playing     | Every Xs   |
| Paused      | Stopped    |
| Ended       | Stopped    |

**Note:** Browsers may throttle background tab intervals to ~1 minute. This is acceptable - heartbeats will still arrive, just less frequently when the tab is hidden.

---

## Testing Checklist

1. **Basic heartbeat:** Play video, verify heartbeat events arrive at server every ~30s
2. **Pause stops heartbeat:** Pause video, verify no more heartbeats
3. **Resume restarts heartbeat:** Resume video, verify heartbeats resume
4. **Video end stops heartbeat:** Let video play to end, verify heartbeats stop
5. **Existing events still work:** Verify play/pause/ended/seeked events still fire as before
6. **Custom interval:** Deploy with different `HEARTBEAT_INTERVAL_MS`, verify interval changes
