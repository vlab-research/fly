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

## Chat Log Publisher

The `lib/chat-log/publisher.js` module publishes chat log entries to a Kafka topic for every visible message in a conversation (both bot echoes and user messages). This feeds the `chat_log` database table via a downstream scribble sink.

### Architecture

The module follows a functional core / imperative shell pattern:

- **`extractChatLogEntry(event, state)`** -- Pure function. Given a parsed Facebook webhook event and the current state machine state, returns a chat log entry object or `null`. Uses `categorizeEvent()` from `machine.js` to classify the event. Only ECHO, TEXT, QUICK_REPLY, and POSTBACK events produce entries; all other event types (synthetic events, watermarks, referrals, reactions, etc.) return `null`.

- **`publishChatLog(produce, topic, rawEvent, state)`** -- Thin IO wrapper. Parses the raw event, calls `extractChatLogEntry`, and if the result is non-null, publishes to Kafka using the same `produce()` helper used for state/response/payment topics.

### Integration

The publisher is called in the `processor()` function in `lib/index.js`, after `machine.run()` completes and all other publish operations (state, responses, payment) have run. It only activates when the `VLAB_CHAT_LOG_TOPIC` environment variable is set -- if not configured, the publisher is silently skipped (graceful degradation).

### Environment Variables

| Variable | Description |
|----------|-------------|
| `VLAB_CHAT_LOG_TOPIC` | Kafka topic for chat log entries (e.g., `vlab-prod-chat-log`). If not set, chat logging is disabled. |
