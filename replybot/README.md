# Replybot

Make sure you have a folder called keys at the root of this project, with a single file: "key.json" -- which is the google application credentials keys.

Also make sure you have the .env file at the root of the project. This is currently the SAME for both botserver and replybot, so symlink one to the other!

## Setup local kubernetes

Make sure you install the following on your machine:

* [Virtual Box](https://www.virtualbox.org/wiki/Downloads)
* [kubectl](https://kubernetes.io/docs/tasks/tools/install-kubectl/)
* [minikube](https://kubernetes.io/docs/tasks/tools/install-minikube/)
* [helm](https://docs.helm.sh/using_helm/#installing-helm)

Now setup minikube and kubectl:

``` shell
minikube start
kubectl use-context minikube
```

Now, initialize helm in you minikube cluster and install Kafka using helm:

``` shell
helm --kube-context minikube init
helm repo add bitnami https://charts.bitnami.com/bitnami
helm --kube-context minikube install --name spinaltap --values kafka-values-dev.yaml bitnami/kafka
```

Run this in the shell you will be using

``` shell
eval $(minikube docker-env)
```

To reload or start an app (both botserver and replybot), inside the folder run:

NOTE: You will receive warnings the first time due to the fact that the script tries to delete the deployment, which will error if the deployment does not exist. That's ok.

``` shell
./dev.sh
```

You should now see the pods running at:

``` shell
kubectl get po
```

And you can get logs for an individual pod via:

``` shell
kubectl logs [POD_NAME]
```

Or, handily, you can setup the following script (as kube-logs.sh, for example) and alias it to something useful on your computer:

``` shell
NAME=$1
NUM=$2
kubectl logs $(kubectl get pods -l "app=${NAME}" -o jsonpath="{.items[${NUM}].metadata.name}")
```

Which you can then run:

``` shell
alias kubelog=kube-logs.sh
kubelog gbv-replybot 1
```

## Event Normalization (UniversalEvent)

All events entering the replybot are normalized by `lib/event-normalizer.js`
into a `UniversalEvent` (`{ event_id, user_id, timestamp, source, event_type,
payload, raw }`) before the state machine sees them. The machine
(`lib/typewheels/machine.js`) switches only on `event_type` and reads typed
`payload` objects — it never touches raw Messenger fields.

Notes on specific shapes:

- **Payload parsing** — Messenger delivers `quick_reply`, `postback`, and
  `optin` payloads as JSON strings; the normalizer parses them to objects
  (`parsePayload`), falling back to the raw string when not valid JSON.
- **Optin** — normalized to `event_type: 'optin'` with
  `payload: { type: 'optin', optin_type: <messenger optin.type, e.g.
  'one_time_notif_req'>, token: <one_time_notif_token>, payload: <parsed
  notify-field ref object> }`. The machine's OPTIN case checks
  `payload.optin_type`, stores the token in `state.tokens`, and answers the
  pending `notify` field (the validator matches `payload.payload.ref` against
  the field ref). After a timeout fulfils a notify wait, the stored token is
  attached to the outgoing message and message-worker sends it with
  `recipient: { one_time_notif_token }` instead of the user id.

### Testing

`npm test` runs the full mocha suite via the quoted glob `'lib/**/*.test.js'`
(mocha expands it; unquoted, the shell would skip top-level `lib/*.test.js`
files like `event-normalizer.test.js` and `generic-translator.test.js`).
Test fixtures for UniversalEvents live in `lib/typewheels/events.test.js` and
must mirror the normalizer's real output shapes.

(The former chat-log publisher — `lib/chat-log/publisher.js` and
`VLAB_CHAT_LOG_TOPIC` — was removed with the platform abstraction; see
`documentation/chat-message-logging.md`.)
