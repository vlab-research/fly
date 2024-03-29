# Question types

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


## Statement

A statement is a simple message that you send. The bot will move on to the next question without waiting for a response.

In Typeform, pick "Statement"

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

## Links

It's possible to send a link as a button and allow the users to open it in a Messenger webview:

JSON:
```json
{
  "type": "webview",
  "url": {
    "base": "links.vlab.digital",
    "params": {
      "url": "asiapacific.unwomen.org/en/countries/india"
    }
  },
  "buttonText": "Visit UN Women",
  "extensions": false,
  "keepMoving": true
}
```

To track information about the user, add metadata as query parameters in addition to `url` in the `url` value. For example, you can add the user id by adding `id` with a typeform ref to a "hidden field" called "id" (note, you will probably need to type out the "@id" part inside Typeform so it links it to a hidden field properly):

```json
{
  "type": "webview",
  "url": {
    "base": "links.vlab.digital",
    "params": {
      "url": "asiapacific.unwomen.org/en/countries/india",
      "id": @id
    }
  },
  "buttonText": "Visit UN Women",
  "extensions": false,
  "keepMoving": true
}
```

Set `keepMoving` to `true` if you want the message to act like a "statement" and continue to the next message. Otherwise, you can combine with a "wait" to wait until the user has clicked the link:

JSON:
```json
{
  "type": "webview",
  "url": {
    "base": "links.vlab.digital",
    "params": {
      "url": "asiapacific.unwomen.org/en/countries/india"
    }
  },
  "buttonText": "Visit UN Women",
  "responseMessage": "Click on the button to visit the website",
  "extensions": false,
  "wait": {
    "type": "external",
    "value": {
      "type": "linksniffer:click",
      "url": "https://asiapacific.unwomen.org"
    }
  }
}
```

You can set `extensions` to `true` if the page you are visiting is using Messenger Extensions (i.e. Fly Survey's "Moviehouse" which can be used to watch Vimeo videos and track video-watching events)

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

`value` written as "1 minute" or "2 hours" or "2 days".


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
