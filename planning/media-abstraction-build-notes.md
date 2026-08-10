# Media abstraction — message-worker build notes

Implements planning/media-abstraction.md §7 (message-worker component work), §8.3
(resolution rules), §13 (failure modes) in `message-worker/`. `mediaresolve/`,
`mediastore.go`, and `types/media.go` were already written and passing before this pass;
this note covers the worker/translator/config wiring done on top of them.

## What changed

- `types/command.go`: added `SendMessageCommand.ResolvedMedia *types.MediaSendable`
  (`json:"-"`) — a derived translation input, never wire data.
- `worker.go`: added `Worker.mediaStore` / `mediaHandleUse` / `mediaMargin` fields,
  `WithMediaStore(store, use, margin) *Worker` (does not touch `NewWorker`'s signature — it
  has many callers), and `resolveMedia(ctx, *cmd)`, called at the top of
  `processSendMessage` before the platform switch. `processSendMessage` still takes `cmd`
  by value; `resolveMedia` is passed `&cmd` locally so it can set `ResolvedMedia` before the
  translators read it off the same `cmd`.
- `translator.go` / `translator_whatsapp.go` / `translator_instagram.go`: the *inner*,
  unexported per-media-type functions (`translateMessengerMedia`,
  `translateWhatsAppMedia`, `translateInstagramMedia`) each gained a
  `resolved *types.MediaSendable` parameter and branch on `resolved.Kind` when no legacy
  Messenger attachment id is present. The exported `TranslateToMessenger` /
  `TranslateToWhatsApp` / `TranslateToInstagram` signatures are unchanged.
- `types/whatsapp.go`: `WhatsAppMedia` gained an `ID` field; both `Link` and `ID` are now
  `omitempty` so exactly one serialises.
- `config.go`: `MEDIA_HANDLE_USE` (bool, default `false`) and `MEDIA_HANDLE_MARGIN`
  (duration, default `1h`), via new `getEnvAsBool` / `getEnvAsDuration` helpers following the
  existing `getEnvOrDefault` style.
- `cmd/message-worker/main.go`: constructs a `PostgresMediaStore` and wires it in with
  `worker.WithMediaStore(...)`. This wasn't called out as an explicit numbered step in the
  spec, but without it the config fields and `WithMediaStore` setter would be dead code —
  the feature could never actually turn on. A store construction failure at startup logs a
  warning and the worker proceeds without one (URL-only sends), matching "the handle layer
  is an optimisation, never a requirement" rather than making it fail startup.
- `worker_media_test.go` (new): the six logic/regression tests from §10 — degradation on a
  store error (most important), live handle → by-id on both Messenger and WhatsApp, miss →
  by-url, third-party URL never queries the store, legacy attachment id never queries the
  store, and `MEDIA_HANDLE_USE=false` never queries the store even with a store configured.
- `translator_attachment_id_test.go`: the two call sites (`translateWhatsAppMedia`,
  `translateInstagramMedia`) got a `nil` argument added. **No pinned JSON literal was
  touched.**

## Metrics decision (spec step 6)

Searched the whole repo (`grep -r promauto\|client_golang`) — no hits in any `.go` file, only
in `go.sum`/`go.work.sum` as a transitive dependency of something else. message-worker has no
existing Prometheus metrics idiom to follow. Per the spec's fallback instruction, the by-URL
health signal (§8.5: "a by-URL send for dashboard-uploaded media is an anomaly ... should sit
near zero") is emitted as a structured log line instead:

```go
w.logger.Info("media resolved by_url",
    zap.String("kind", resolved.Kind.String()),
    zap.String("asset_id", assetID),
    zap.String("platform_account_id", cmd.PlatformAccountID),
)
```

**This needs a metrics decision from a human**: either message-worker should adopt
`client_golang`/`promauto` (checking what scrapes it — `devops/prometheus/values.yaml` — and
adding a `ServiceMonitor`), or the by-URL rate should be derived from these log lines in
whatever log pipeline this service already feeds. Nothing was invented here.

## Things that would have broken a pinned test — none

Following the spec as given did not require touching either the `AttachmentPayload` pins or
the `TranslateToMessenger` full-JSON pins. The legacy branch in `translateMessengerMedia`
(`if types.Blank(msg.MediaAttachmentID) { ... } else { payload.AttachmentID = *msg.MediaAttachmentID }`)
is untouched on the `else` side, which is what the pins actually exercise.

## Verification

```
cd message-worker
gofmt -l .      # cmd/message-worker/main.go, kafka.go, types/messenger.go flagged --
                 # all pre-existing (import ordering / other), confirmed via `gofmt -d`
                 # and `git diff` that none of my edits introduced them
go build ./...  # clean
go vet ./...    # clean
go test ./...   # all green, including translator_attachment_id_test.go unchanged pins
```
