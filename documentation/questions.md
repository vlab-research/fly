# Question types

#### Stitch

When stitching from one form to another, the "stitch" must be a statement:


JSON:
```yaml
{"type": "stitch",
 "stitch": { "form": "FORM_SHORTCODE" }}
```

Where `FORM_SHORTCODE` is the shortcode of the form you'd like to move to.

#### Wait - Timeout

##### Relative timeout:


JSON:

```json
{
    "type": "wait",
    "responseMessage": "Please wait!",
    "wait": {
        "notifyPermission": "true",
        "type": "timeout",
        "value": "1 minute"
    }
}
```

`value` written as "1 minute" or "2 hours" or "2 days".


##### Absolute timeout:

JSON:

```json
{
    "type": "wait",
    "responseMessage": "Please wait!",
    "wait": {
        "type": "timeout",
        "value": {
            "type": "absolute",
            "timeout": "2021-08-01 12:00"
        }
    }
}
```

#### Notify

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

#### Payment - Reloadly

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

You will have the following hidden fields that can be used for logic and error messages:

1. `e_payment_reloadly_success` - will be "true" if the payment succeeded.
2. `e_payment_reloadly_error_message` - an error message, in english, of why the payment failed.
3. `e_payment_reloadly_id` - the PAYMENT_ID
```

# Seeds

### Using Random Seeds for Randomizing Logic

Seeds work via hidden fields. Create a hidden field named `seed_N`, where `N` is replaced with the number of arms you wish to randomize. For example: `seed_2`, `seed_3`, `seed_4`, `seed_5`,..., `seed_100`.

This hidden field will have the assignment of each user, which will be an integer between 1 and N. For example, if you made a hidden field called `seed_3`, each user will have a value of that field equal to 1, 2, or 3.

Now use the hidden field in your logic jumps. If, for example, you create a hidden field called `seed_3`, then create logic jumps such that:

if `seed_3 == 1` do A, if `seed_3 == 2` do B, if `seed_3 == 3` do C.