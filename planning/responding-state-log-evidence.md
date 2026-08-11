# RESPONDING-state bug — log evidence from production

**Snapshot**: 2026-05-24 ~21:30 UTC. Logs from 8 `gbv-replybot-*` pods, last 4 hours, namespace `default`, cluster `gke_toixotoixo_europe-west1-b_toixo`. ~22,000 log lines total.

## Headline

**The Facebook send is succeeding. The echo webhook for `user_phone_number` quick replies is never delivered.** Without the echo, the state machine has no path out of `RESPONDING`, so the user is stuck even though they received the message and replied.

## Evidence chain

### 1. Bot sends "share your phone number" prompt

For stuck user `27055780770723719` on page `101435865704727`, a `machine_report` event published the action:

```json
{
  "recipient": {"id": "27055780770723719"},
  "message": {
    "text": "*You now qualify for your reward!* 🎉\n\nPlease enter your number below. For example: +2541234567890",
    "quick_replies": [{"content_type": "user_phone_number"}],
    "metadata": "{\"ref\":\"mobile_phone\",\"type\":\"phone_number\"}"
  }
}
```

`newState.state` was set to `RESPONDING` and persisted.

### 2. The user received the message and replied with their phone number

Three minutes later, an inbound TEXT event arrived:

```json
{
  "sender": {"id": "27055780770723719"},
  "recipient": {"id": "101435865704727"},
  "timestamp": 1779645110315,
  "message": {
    "mid": "m_CWrzkQdNP0Zy1g8...",
    "text": "+254702787794"
  },
  "source": "messenger"
}
```

So the FB send did **not** fail. The user got the message and shared their phone number.

### 3. No echo event ever arrived for that send

Across all 8 pods in 4 hours:
- **22 `user_phone_number` quick-reply sends** in `machine_report.actions`
- **0 `is_echo:true` events** for any of those sends

The 20 echo events in the window are all for plain-text or multiple-choice messages. The three pages that *do* show echoes (`758018254333043`, `1004050362793638`, `1855355231229529`) confirm echoes work for those pages in general — just not for `user_phone_number` quick replies.

### 4. Because state is `RESPONDING`, the user's reply is silently dropped

Per `replybot/lib/typewheels/machine.js` (lines 467, 476, 492), any inbound TEXT/QUICK_REPLY/POSTBACK while `current_state === 'RESPONDING'` returns `_noop()`. The user's `+254702787794` reply is discarded.

### 5. Dean keeps re-sending the same prompt

Dean fires a `redo` synthetic event every ~30 minutes. Each one re-publishes the same `machine_report` with the same action (the user_phone_number prompt) and appends a new timestamp to `state_json.retries`. The user receives multiple copies of "*You now qualify for your reward!*" but their replies remain ignored. After ~30 retries (~15h) Dean's WHERE clause excludes the user (`dean/queries.go:109`) and `next_retry` is pushed ~6 weeks out — but the state stays `RESPONDING` forever.

## Cross-evidence: same shape on three independent users

| user | page | message | reply received? | echo? |
|---|---|---|---|---|
| `33301496839494585` | 758018254333043 | "What phone number..." (user_phone_number QR) | yes (`+2349036665231`) | none |
| `27055780770723719` | 101435865704727 | "qualify for reward... phone number" (user_phone_number QR) | yes (`+254702787794`) | none |
| `35579554001692189` | 101435865704727 | "qualify for reward..." (user_phone_number QR) | (not in 4h window) | none |

All three are stuck on the same step (`*incentive` form, asking for phone number to disburse a mobile-credit reward) with the same outgoing `user_phone_number` quick-reply, and none have produced an echo.

## Why `fb_error_code` is NULL

Because there is no FB send failure. The send succeeded; only the *echo callback* failed to arrive. The replybot has no signal that anything is wrong — so nothing is written to `state_json.error` or the `fb_error_code` column.

## Action distribution in the 4h window

| `content_type` | count |
|---|---|
| `text` | 10 |
| `user_phone_number` | 22 |

The bot heavily uses `user_phone_number` quick replies in incentive flows. Every one of these that's been counted is currently a stuck user (most are repeat retries of the same prompt).

## Open questions for Phase 2

1. **Why no echo for `user_phone_number`?** Is this a known FB Messenger Platform behavior (echoes suppressed for messages containing sensitive-data quick replies), a page subscription gap, or a regression in FB's webhook delivery?
2. **Why does the code rely on echoes as the sole exit from `RESPONDING`?** A "fire-and-forget" model with a synthetic exit on send success (or a send-deadline timer) would avoid the trap entirely.
3. **Why does the user's reply get silently dropped instead of unblocking the state?** If we receive a user TEXT while in RESPONDING for >N seconds, the natural recovery is to treat the implicit-echo-as-received.

## What to verify next

- Try sending a `user_phone_number` quick reply from a staging page and check whether the echo arrives. If 0% echo rate, file with FB or workaround.
- Check the page-app webhook subscription fields (`message_echoes`) on the affected pages.
- Re-evaluate whether the echo-required design is sound — fix the architecture rather than the symptom.
