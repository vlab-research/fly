# Moviehouse

A lightweight video hosting web application that embeds Vimeo videos in Messenger WebView. Part of the Fly ecosystem, Moviehouse provides a seamless video viewing experience for chatbot users.

## Usage

### Opening Videos from Fly Chatbot

Videos are accessed via URL with query parameters:

```
https://your-moviehouse-domain.com/?id={VIMEO_VIDEO_ID}&pageId={PAGE_ID}&userId={PSID}
```

**Required Parameters:**
- `id` - The Vimeo video ID to display
- `pageId` - The Facebook Page ID for the chatbot
- `userId` - The user's PSID. **Required in the default (direct) mode** — see below.

**Optional Parameters:**
- `useExtensions=true` - Resolve the PSID via Messenger Extensions instead of
  the URL. Only then is `userId` unnecessary.

### The two modes — and why `userId` is normally required

`script.js` branches on the `useExtensions` query param at `DOMContentLoaded`:

| URL | Mode | Behavior |
|-----|------|----------|
| *(no `useExtensions`)* — **the default** | Direct | `validateRequiredParams()` demands `id`, `pageId`, **and `userId`**, then plays with the PSID straight from the URL. |
| `useExtensions=true` | Messenger Extensions | `MessengerExtensions.getContext()` resolves the PSID; `userId` in the URL is ignored. Requires the domain to be whitelisted on the Facebook App. |

Omitting `userId` without `useExtensions=true` fails closed with
**"Required parameters are missing: userId. Please make sure you opened this
link correctly."** — the page never loads the player.

> Note: the `extensions` key in a Fly survey's `webview` metadata is a
> *different* thing — it sets `messenger_extensions` on the Messenger button
> (whether Messenger opens the URL in an authenticated webview), and defaults
> to `true` in `translate-typeform`. It does **not** set the `useExtensions`
> query param, so it does not relieve you of passing `userId`.

### Example

Fly surveys pass the PSID through interpolation as `{{hidden:id}}` — that key
resolves to `user.id` via `getFromMetadata` in
`replybot/lib/typewheels/form.js`. **Beware `{{hidden:userid}}`: it is not a
real key and silently interpolates to an empty string**, producing exactly the
missing-parameter error above.

```json
{
  "type": "webview",
  "url": {
    "base": "virtuallab-videos.netlify.app",
    "params": {
      "id": "1143996177",
      "pageId": "101435865704727",
      "userId": "{{hidden:id}}"
    }
  },
  "buttonText": "Watch now!",
  "extensions": true,
  "keepMoving": true
}
```

The equivalent plain-string URL form works identically:

```
https://virtuallab-videos.netlify.app/?id=123456789&pageId={{hidden:pageid}}&userId={{hidden:id}}
```

When a user clicks a link to this URL from within a Messenger conversation, they'll see the Vimeo video embedded in a full-screen player.

### On WhatsApp

The page itself needs no changes: the default direct mode reads the PSID from
the URL, so it works in the phone's ordinary browser with no Messenger
Extensions. `pageId` is the WhatsApp `phone_number_id` and `userId` the user's
phone number; moviehouse echoes both back on every event, and replybot recovers
the conversation's platform from the persisted `md.platform`.

What differs is how the *button* is delivered. Messenger gets a `web_url` button
template; WhatsApp gets an interactive `cta_url` message, whose button label is
capped at **20 characters** — over that, the send fails outright rather than
truncating. Keep `buttonText` short for any survey that runs on WhatsApp. See
`../documentation/platform-abstraction.md` → *webview → `cta_url`*.

### Tracked Events

All video interactions are automatically sent back to the Fly server:
- `moviehouse:play` - Video starts playing
- `moviehouse:pause` - Video paused
- `moviehouse:ended` - Video finished
- `moviehouse:seeked` - User skipped to different time
- `moviehouse:volumechange` - Volume adjusted
- `moviehouse:playbackratechange` - Playback speed changed
- `moviehouse:error` - Video error occurred

### Used by the Fly smoke test

The production smoke survey (`../smoke-test/`, `form-a.json` → `movie_webview`)
opens this player via a `webview` button and `wait`s on the `moviehouse:play`
event, then branches on the flattened `e_moviehouse_play_id` hidden field with
logic. See `../smoke-test/README.md` → "The moviehouse section" for the full
wiring and the string-`id` matching gotcha. This is the canonical live example
of reacting to moviehouse events.

### Browser Requirements

**Mobile:** Must be viewed in the Messenger mobile app
**Desktop:** Can be viewed at messenger.com in a modern browser

These constraints apply to **Messenger Extensions mode** (`useExtensions=true`),
where the page displays browser/forbidden errors (`2071010`, `2071011`) if
opened outside a Messenger conversation. In the default direct mode the PSID
comes from the URL, so any browser can open the link.