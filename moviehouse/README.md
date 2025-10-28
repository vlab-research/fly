# Moviehouse

A lightweight video hosting web application that embeds Vimeo videos in Messenger WebView. Part of the Fly ecosystem, Moviehouse provides a seamless video viewing experience for chatbot users.

## Usage

### Opening Videos from Fly Chatbot

Videos are accessed via URL with query parameters:

```
https://your-moviehouse-domain.com/?id={VIMEO_VIDEO_ID}&pageId={PAGE_ID}
```

**Required Parameters:**
- `id` - The Vimeo video ID to display
- `pageId` - The Facebook Page ID for the chatbot

**Optional Parameters:**
- `userId` - Direct user ID (bypasses Messenger Extensions authentication)

### Example

```
https://moviehouse.example.com/?id=123456789&pageId=987654321
```

When a user clicks a link to this URL from within a Messenger conversation, they'll see the Vimeo video embedded in a full-screen player.

### Tracked Events

All video interactions are automatically sent back to the Fly server:
- `moviehouse:play` - Video starts playing
- `moviehouse:pause` - Video paused
- `moviehouse:ended` - Video finished
- `moviehouse:seeked` - User skipped to different time
- `moviehouse:volumechange` - Volume adjusted
- `moviehouse:playbackratechange` - Playback speed changed
- `moviehouse:error` - Video error occurred

### Browser Requirements

**Mobile:** Must be viewed in the Messenger mobile app
**Desktop:** Can be viewed at messenger.com in a modern browser

The page will display appropriate error messages if accessed outside these contexts (unless `userId` parameter is provided).