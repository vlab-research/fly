# Question types

## Where you write all of this

**Every field is authored in Typeform.** There is no field builder in the Fly
dashboard — the dashboard's "create survey" flow is a *picker*: you choose one of
your existing Typeform forms, give it a shortcode and a name, and Fly fetches the
form's JSON from the Typeform API and stores it verbatim
(`dashboard-server/api/surveys/survey.controller.js` → `TypeformUtil.TypeformForm`).
Editing a question means editing it in Typeform and re-importing.

Simple types are just Typeform question types — "In Typeform, pick Short Text".

**Everything richer is written in the field's Description box.** Fly reads
`properties.description`, parses it as YAML (JSON is valid YAML, so both the
`{"type": "webview", ...}` and the `type: webview` forms below work), and if the
result has a `type` key it *replaces the field's type with that value* and merges
the whole blob into the field's metadata. That promotion step is
`addCustomType` in `replybot/lib/typewheels/form.js`.

Three consequences worth knowing, because they are not obvious:

1. **The Typeform question type barely matters for these.** Put `type: webview`
   in the Description of a Statement and Fly treats it as a webview. What
   Typeform thinks it is only decides how the *editor* renders it. In production
   right now, **zero** stored fields carry a literal `"type": "webview"` in their
   Typeform JSON — every single one arrives through this promotion.
2. **Your Description must be valid YAML.** If it does not parse, Fly silently
   keeps the field as its original Typeform type and your configuration is
   ignored — no error. The most common cause is an unquoted value containing
   `[`, `]`, `:` or `#`.
3. **Typeform auto-linkifies URLs you paste**, turning `https://who.int` into
   `[who.int](https://who.int)`. Fly unwraps markdown links back to the bare URL,
   but a link inside an *unquoted* YAML value breaks the parse (see point 2), so
   **quote any value containing a URL**.

Interpolation (`{{hidden:id}}`, `{{field:some_ref}}`) is applied to the
Description *before* it is parsed, so you can build values out of hidden fields.
A ref may carry a transform after a pipe — `{{field:pay_1_phone|e164}}` — which
rewrites the value before it is substituted. `e164` is the only one today; see
**Phone Number** below. An unknown transform name is an error, not a silent
pass-through.

Fly supports the following question types:

## Short Text

This is a free text question. The user can type anything and send it in the chat and it will be accepted as valid.

In Typeform, pick "Short Text"

## Multiple Choice

Creates a multiple choice question.

In Typeform, pick "Multiple Choice".

Notes:

1. You can have a maximum of 13 answers.
2. If any answer text is longer than 15 characters, you should use letters A,B,C...M as the answers instead and the question text should be written in the following format:

```
Which region do you live in?
-A. North Central (Middle Belt)
-B. North East
-C. North West
-D. South East
-E. South South (Niger Delta)
-F. South West
```

The `-` and the `.` before and after the letters are optional, but recommended for legibility.

## Number

Number type validates that the user has sent us a number and only a number. To change the error message when a user enters something other than a number, do: ....

In Typeform, pick "Number".

## Phone Number

Validates that the user has sent a number that can actually be dialed.

In Typeform, pick "Phone Number", and **set the question's country to the country
you are recruiting in** — the setting is stored as `default_country_code` and it
is what lets a respondent answer with a local number instead of the full
international form. Either case works (`AR` or `ar`). You can also set it in
the Description with `validate: {country: AR}`; if both are set, the Description
wins.

With a country declared, all of these are accepted and mean the same handset:
`+5491164018373`, `+54 9 11 6401-8373`, `5491164018373`, `1164018373`. Without
one, only an international number is accepted (the `+` is optional) and a local
number is refused — so if you leave the country unset, the question text must
ask for the country code.

To pay the number, interpolate it with the `e164` transform, which turns
whatever the respondent typed into the form the payment provider dials:

```json
{"account_number": "{{field:pay_1_phone|e164}}"}
```

**Quote it.** Unquoted, YAML reads `+541164018373` as a number and the `+`
disappears.

The country comes from the *phone question being referenced*, not from the
payment question doing the interpolating, so the two can sit anywhere in the
form. Full behavior, including what is sent for Argentina:
`documentation/phone-numbers.md`.

## Statement

A statement is a simple message that you send. The bot will move on to the next question without waiting for a response.

In Typeform, pick "Statement"

## Ending (thank-you screen)

A conversation ends when the bot sends a field of type `thankyou_screen` and
sees its echo; the state becomes `END` and nothing further is asked. Fly appends
a form's Typeform thank-you screens *after* its fields
(`replybot/lib/typewheels/typeform.js`), so you reach one with a logic jump or by
running off the last field.

Two things are not obvious:

1. **Only the first line of the title is sent.** The rest is dropped
   (`generic-translator.js` `translateStatement`), because Typeform's own
   default ending carries its "create your own" boilerplate on line two. An
   ending that needs more than one paragraph loses everything after the first
   `\n` on the live channel, with no error; write it as a single line.
2. **Any field can be an ending.** `{"type": "thankyou_screen"}` in a
   Statement's Description promotes it (see the top of this page). A form whose
   only job is to close a conversation, such as a bail destination, is
   best written this way: its first field is the ending, so a respondent
   switched into it gets that one message and the conversation ends. A form
   with no real fields and only a thank-you screen depends on Typeform
   returning an empty `fields` array, and a missing key breaks the form load.

A respondent who writes after the end gets a reply, then the ending is sent
again. The reply is the ending's `responseMessage` if its Description sets one,
else the form's `block.shortText.placeholder` custom message, else the English
default "Sorry, I can't accept any responses now." For a non-English form,
set `responseMessage`:

```json
{"type": "thankyou_screen",
 "responseMessage": "Ya está todo listo, no hace falta que respondas nada más."}
```

## Image

JSON:
```json
{"type": "attachment",
 "keepMoving": true,
 "attachment": {
    "type": "image",
    "url": "https://i.imgur.com/ZSHauqq.png"
 }
}
```

## Video

JSON:
```json
{"type": "attachment",
 "keepMoving": true,
 "attachment": {
    "type": "video",
    "url": "https://url-to-your-video.mp4"
 }
}
```

## Tracked links

Send a link as a button, record the click, and optionally wait for it before
moving on. Fly builds the whole URL — you supply the destination.

```yaml
type: link_tracking
url: "https://asiapacific.unwomen.org/en/countries/india"
buttonText: Visit UN Women
keepMoving: true
```

That is the entire field. There is no participant id to pass, no page id to copy
from another survey, and no hidden field to wire up: Fly knows which conversation
it is sending into, and stamps the participant, the account and the platform into
the URL itself.

`tel:`, `mailto:` and `sms:` destinations work the same way and are tracked the
same way:

```yaml
type: link_tracking
url: "tel:+234-0700-220-1122"
buttonText: Call NPHCDA
keepMoving: true
```

Set `keepMoving: true` to make the message behave like a Statement and continue
to the next question immediately. Otherwise combine it with a `wait` to hold the
conversation until the participant actually clicks:

```yaml
type: link_tracking
url: "https://asiapacific.unwomen.org/en/countries/india"
buttonText: Visit UN Women
responseMessage: Click on the button to visit the website
wait:
  type: external
  value:
    type: linksniffer:click
```

> **A `wait` with no timeout hangs forever if the click never arrives.** If the
> participant closes the message, the conversation stops there. Prefer pairing it
> with a timeout so there is always a way out:
>
> ```yaml
> wait:
>   op: or
>   vars:
>     - type: external
>       value:
>         type: linksniffer:click
>     - type: timeout
>       value: 1 day
> ```
>
> The conversation moves on at whichever comes first. See "Wait - Timeout" below
> for how compound waits are scheduled.

## Videos (Moviehouse)

Play a Vimeo video and get an event for every play, pause, seek and finish, plus
a heartbeat every 30 seconds while it plays. You supply the video id:

```yaml
type: moviehouse
videoId: "164118668"
buttonText: Watch the video
wait:
  type: external
  value:
    type: moviehouse:play
```

The `videoId` is the number in the Vimeo URL — `https://vimeo.com/164118668` is
`164118668`. **Quote it.** Unquoted, YAML reads it as a number, which mostly
works but will bite you on an id with a leading zero.

As with tracked links, that is the whole field. You do not pass `userId`, you do
not pass `pageId`, and you do not choose between the production and staging video
players — Fly picks the right one for the environment the survey is running in.

The events you can `wait` on are `moviehouse:play`, `moviehouse:pause`,
`moviehouse:ended`, `moviehouse:seeked`, `moviehouse:volumechange`,
`moviehouse:playbackratechange` and `moviehouse:error`. The same warning about a
`wait` with no timeout applies, and applies harder: a video the participant never
opens produces no event at all.

### Why these replaced the old way of doing it

Both of these used to be written as a `webview` (below) with a hand-built URL —
you typed the tracking service's hostname yourself and passed the participant and
the account as query parameters, usually copied from another survey. That put
four things in researchers' hands that were never really theirs to get right, and
all four went wrong in production:

| What you used to write by hand | How it failed |
|---|---|
| the service's hostname | two of the hostnames in circulation are now dead. `virtuallab-videos.netlify.com` returns 404 and carries **490 stored fields**; `gbvlinks.nandan.cloud` fails its TLS certificate and carries **193**. Every one of them is a button that cannot open. |
| `pageId` / `pageid` | **465 of 570** Moviehouse fields hardcode an account id copied from elsewhere. 63 of those are not valid ids at all. On 2026-08-13 one of them sent a WhatsApp participant's video event to a Facebook page, and that participant's conversation was lost. |
| `userId` / `id` | **411 of 570** Moviehouse fields omit it, which stops the video loading entirely. `{{hidden:userid}}` — an easy typo for `{{hidden:id}}` — is not a real key and silently becomes empty. |
| the platform | a hand-written link cannot know whether the conversation is on Messenger or WhatsApp, so it was assumed to be Messenger. On a WhatsApp survey that assumption is wrong, and a `wait` on the click never resolves. |

None of those are expressible any more. Choosing the field type *is* the opt-in;
there is no flag to remember and nothing to copy.

**Migrating an existing field** is usually deleting most of it. This:

```json
{"type": "webview",
 "url": "https://virtuallab-videos.netlify.com/?id=164118668&pageId=105246245358509&userId={{hidden:id}}",
 "buttonText": "Watch the video",
 "extensions": false,
 "wait": {"type": "external", "value": {"type": "moviehouse:play", "id": "164118668"}}}
```

becomes this:

```yaml
type: moviehouse
videoId: "164118668"
buttonText: Watch the video
wait:
  type: external
  value:
    type: moviehouse:play
```

`keepMoving`, `wait`, `responseMessage` and `buttonText` all mean exactly what
they meant before, so a field's behaviour in the conversation does not change —
only the URL it produces does.

## Webview (raw link)

For a link to a page that is not one of ours, use `webview`. It sends the URL
exactly as you write it, with no tracking and nothing added:

```json
{
  "type": "webview",
  "url": "https://asiapacific.unwomen.org/en/countries/india",
  "buttonText": "Visit UN Women",
  "extensions": false,
  "keepMoving": true
}
```

`url` accepts **two forms**, and both are in wide use — roughly 780 production
fields use the string form above and 227 use the object form below, which builds
the URL from a bare host plus query parameters:

```json
{
  "type": "webview",
  "url": {
    "base": "asiapacific.unwomen.org/en/countries/india",
    "params": {
      "vlab_id": "{{hidden:id}}"
    }
  },
  "buttonText": "Visit UN Women",
  "extensions": false,
  "keepMoving": true
}
```

The object form also takes an optional `protocol` (default `https`).

`keepMoving` and `wait` work as they do above, though there is no click event to
wait on for a third-party page.

Set `extensions` to `true` only if the page uses Messenger Extensions **and** its
domain is whitelisted in the Facebook app. If it is not whitelisted, the button
will not open. Fly's own link types set this correctly for you.

> **A `webview` pointing at one of Fly's own services is not tracked.** If you
> write a raw `webview` whose URL happens to be `links.vlab.digital` or
> `virtuallab-videos.netlify.app`, Fly does not recognise it, does not add the
> participant's identity, and does not fix the hostname — it sends exactly what
> you typed. Those fields keep working exactly as well (or as badly) as they do
> today. To get tracking, change the field's `type` to `link_tracking` or
> `moviehouse` as shown above.

## Stitch

When stitching from one form to another, the "stitch" must be a statement:


JSON:
```json
{"type": "stitch",
 "stitch": { "form": "FORM_SHORTCODE" }}
```

Where `FORM_SHORTCODE` is the shortcode of the form you'd like to move to.

## Wait - Timeout

### Relative timeout:


JSON:

```json
{
    "type": "wait",
    "responseMessage": "Please wait!",
    "wait": {
        "notifyPermission": "true",
        "type": "timeout",
        "value": {
            "type": "relative",
            "timeout": "2 days"
        }
    }
}
```

`value` written as "1 minute" or "2 hours" or "2 days". Up to three parts,
decimals and abbreviations also work ("90 mins", "1.5 hours", "1 day 2 hours").
A value in any other form never times out. The full syntax is in
`documentation/waits-and-timeouts.md` §3.


### Absolute timeout:

JSON:

```json
{
    "type": "wait",
    "responseMessage": "Please wait!",
    "wait": {
        "type": "timeout",
        "notifyPermission": "true",
        "value": {
            "type": "absolute",
            "timeout": "2021-08-01 12:00"
        }
    }
}
```


### Timeout or event, whichever comes first:

```yaml
wait:
  op: or
  vars:
    - type: external
      value:
        type: moviehouse:play
    - type: timeout
      value: 1 hour
```

`op: or` ends at the first arm satisfied, so it ends at the earliest timeout
arm. `op: and` needs every arm, so it ends at the latest timeout arm, and
only once the other arms have arrived too. Only relative timeouts
are scheduled inside `op`, in the first four arms, one level deep. An absolute or
named (`variable`) timeout inside `op` never fires. See
`documentation/waits-and-timeouts.md` §2.

## Notify

This creates the "Notify Me" built-in message from Facebook, which gives us token to write them later. This is necessary before a Wait/Timeout of more than 24 hours. The system will store all recieved tokens and automatically try and use them if it is sending a message after 24 hours have passed.

JSON:
```json
{"type": "notify"}
```

NOTE: The token only gives you permission to send a single message. As such, the message should be a question and the user will need to respond before anything can continue. Thus, the flow for long timeouts usually looks like this:

1. notify
2. wait
3. question ("do you want to take another quick survey?")
4. statement with stitch to the next form

ALSO NOTE: You need one time notification permission to use the notify type. To get that go to Advanced Messaging under your Page Settings to request the permission.

## Payment - Reloadly

JSON:
``` json
{
    "type": "wait",
    "wait": {
        "type": "external",
        "value": {
            "type": "payment:reloadly",
            "id": "PAYMENT_ID"
        }
    },
    "payment": {
        "provider": "reloadly",
        "key": "name-of-your-credentials",
        "details": {
            "mobile": @MOBILE_QUESTION,
            "operator": @OPERATOR_QUESTION,
            "amount": 100,
            "tolerance": 30,
            "country": "IN",
            "id": "PAYMENT_ID"
        }
    }
}
```

Notes:

1. The "wait" is not strictly necessary but likely desired!
2. `PAYMENT_ID` can be useful to keep track of multiple payments to the same person or different payments to different treatment arms (a unique id per treatment arm).
3. the `key` is the name you give the desired Reloadly credentials in the Fly dashboard.

You will have the following hidden fields that can be used for logic and error messages:

1. `e_payment_reloadly_success` - will be "true" if the payment succeeded.
2. `e_payment_reloadly_error_message` - an error message, in english, of why the payment failed.
3. `e_payment_reloadly_id` - the PAYMENT_ID



## Payment - Generic HTTP Payment Endpoint

This allows you to send payments to an external API via any http request.

JSON:
``` json
{
    "type": "wait",
    "wait": {
        "type": "external",
        "value": {
            "type": "payment:http",
            "id": "PAYMENT_ID"
        }
    },
    "payment": {
        "provider": "http",
        "details": {
            "id": "PAYMENT_ID",
            "method": "POST",
            "url": "https://mypaymentprovider.com/send/money",
            "headers": {"Authorization": "Bearer << MYPROVIDER_TOKEN >>"},
            "body": { "phone": "@MOBILE_QUESTION", "amount": 100, "transaction_id": "survey_x_payment_1" },
            "errorMessage": "path.to.error.message"
        }
    }
}
```

Notes:

1. The "wait" is not strictly necessary but likely desired!
2. `PAYMENT_ID` can be useful to keep track of multiple payments to the same person or different payments to different treatment arms (a unique id per treatment arm).
3. The `body` and `headers` properties are optional.
4. You can pass secrets into the url, the headers, and/or the body. This is done with templating which uses the delimeters `<<` and `>>`. The secrets available are the secrets you create in the dashboard under "Generic Secrets".
5. `errorMessage` is a "json path", in dot notation, to extract the message provided in `e_payment_http_error_message`. If the status code is not 2XX, the service will consider it an error and expect a JSON body response. If the body is `{"error": {"code": "BAD_NUMBER", "message": "Please provide a valid mobile number"}}` then the `errorMessage` property should be `error.message` in order to extract the message "Please provide a valid mobile number".
6. If your HTTP payment endpoint requires the phone number as a string, make sure to wrap the reference to the previous question in quotes (`""`).


You will have the following hidden fields that can be used for logic and error messages:

1. `e_payment_http_success` - will be "true" if the payment succeeded.
2. `e_payment_http_error_message` - an error message, extracted as specified from error json.
3. `e_payment_http_id` - the PAYMENT_ID


# Hidden Fields

Sometimes we surface hidden fields that are too long to be added as hidden fields in Typeform. These can be accessed in the text of a question/statement using the following syntax:

```
{{hidden:e_payment_http_result_message_success}}
```

Where the "too long" hidden field is `e_payment_http_result_message_success` which would be populated, for example, if you had a http payment result that looked like this: `{"message": {"success": "foo"}}` and you wanted to show "foo".


# Seeds

### Using Random Seeds for Randomizing Logic

Seeds work via hidden fields. Create a hidden field named `seed_N`, where `N` is replaced with the number of arms you wish to randomize. For example: `seed_2`, `seed_3`, `seed_4`, `seed_5`,..., `seed_100`.

This hidden field will have the assignment of each user, which will be an integer between 1 and N. For example, if you made a hidden field called `seed_3`, each user will have a value of that field equal to 1, 2, or 3.

Now use the hidden field in your logic jumps. If, for example, you create a hidden field called `seed_3`, then create logic jumps such that:

if `seed_3 == 1` do A, if `seed_3 == 2` do B, if `seed_3 == 3` do C.
