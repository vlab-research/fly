# Incremental Migration Roadmap: Replybot → Platform-Agnostic Architecture

## Context

The `feat/rust-replybot-migration` branch attempted a big-bang rewrite of the Node.js replybot into Rust + Go microservices. That branch has valuable code and tests (~90 commits, 623+ tests) but is too large to ship as one change.

Instead, we're adopting a **strangler-fig approach**: incrementally extracting and refactoring one capability at a time, keeping replybot working at every step. The end goal is WhatsApp support, which requires the system to be platform-agnostic.

**Current state**: Replybot is a monolithic Node.js service that consumes Kafka events, runs a state machine, generates Messenger-specific messages, and sends them directly to the Facebook Graph API. Messenger is the only platform in production.

**Target state**: A platform-agnostic architecture where replybot's core state machine knows nothing about Messenger or WhatsApp. Platform-specific concerns (inbound webhook parsing, outbound message formatting) live in dedicated adapter layers.

---

## The Four Phases

```
Phase 1                Phase 2                Phase 3                Phase 4
───────────────        ───────────────        ───────────────        ───────────────
Extract I/O            Outbound agnostic      Inbound agnostic       WhatsApp

Replybot ──┐           Replybot ──┐           Replybot               Replybot
  [state   │             [state   │             [adapter] ──┐          [adapter] ──┐
   machine]│              machine]│             [state      │          [  FB  ]    │
  [FB send]│  ──→        [publish │  ──→        machine]    │  ──→     [ WA   ]    │
           │              agnostic│            [agnostic    │         [agnostic    │
           ▼              cmds]   ▼             core]       ▼          core]       ▼
        Facebook          ▼                     ▼                      ▼
        Graph API    Msg-Worker              Msg-Worker              Msg-Worker
                     [translate               [translate              [translate
                      to FB]                   to FB]                  to FB]
                         ▼                      ▼                     [translate
                      Facebook               Facebook                 to WA]
                      Graph API              Graph API                  ▼
                                                                    Facebook +
                                                                    WhatsApp APIs
```

---

## Phase 1: Extract Message Sending (Passthrough)

**Goal**: Decouple message delivery from the state machine. Replybot publishes commands to Kafka; a Go message-worker sends them to Facebook.

**What changes**:
- Bring Go message-worker + burrow library from the rust branch
- Add native passthrough mode (worker forwards pre-formatted Facebook payloads)
- Add pass_thread_control command type (handoff moves to worker too)
- Replybot publishes commands to Kafka instead of calling Facebook API directly
- Delete `sendMessage()`, `facebookRequest()`, `passThreadControl()` from replybot
- Only `getUserInfo()` remains as a direct Facebook API call in replybot
- Error handling becomes async (worker reports failures via synthetic events)

**What doesn't change**:
- Replybot still generates Facebook-native message payloads (using `translate-typeform`)
- Replybot still parses Messenger webhook events directly
- State machine logic is untouched
- All other Kafka publishing (state, responses, payments, chat log) stays the same

**Detailed plan**: See `planning/message-worker-extraction-plan.md`

**Key risk**: Async error handling changes the timing of BLOCKED state transitions. Acceptable tradeoff — errors still arrive, just slightly delayed.

**Done when**: All existing integration tests pass with message-worker in the loop. Replybot no longer imports or calls Facebook send/handoff APIs.

---

## Phase 2: Outbound Becomes Platform-Agnostic

**Goal**: Replybot emits platform-agnostic message commands. Message-worker handles all Messenger-specific translation.

**What changes**:
- Replybot stops using `translate-typeform` to generate Facebook-native payloads
- Instead, replybot emits abstract commands: `{ type: "question", text: "...", options: [...] }` or `{ type: "text", text: "..." }` or `{ type: "media", media_type: "image", url: "..." }`
- Message-worker's existing translation logic (`TranslateToMessenger()`) handles conversion to Facebook format (quick_replies, buttons, attachments, etc.)
- Remove the native passthrough mode from phase 1 (no longer needed)
- Remove `translate-typeform` dependency from replybot's message generation path

**What doesn't change**:
- Replybot still parses Messenger webhook events directly (inbound is still Messenger-specific)
- State machine core logic is the same
- Message-worker's Messenger translation already exists and is tested (26 tests on the rust branch)

**Key insight**: The Go message-worker from the rust branch was designed for exactly this. Its `SendMessageCommand` format and `TranslateToMessenger()` function are ready to use. This phase is mostly about changing replybot's `act()`/`respond()` output format, not writing new translation code.

**Key risk**: Subtle differences between `translate-typeform`'s output and the Go translator's output. Need careful comparison testing — same inputs should produce equivalent Facebook API payloads.

**Done when**: Replybot has no Messenger-specific knowledge in its outbound path. `translate-typeform` is no longer used for message formatting. Message-worker handles all Messenger translation.

---

## Phase 3: Inbound Becomes Platform-Agnostic

**Goal**: Replybot's core state machine receives platform-agnostic events. Messenger webhook parsing moves to a dedicated adapter layer within replybot.

**What changes**:
- Create an adapter/normalization layer within replybot that converts raw Messenger webhook events into platform-agnostic events before the state machine sees them
- The state machine's `exec()` function works with abstract event types: `user_text`, `user_choice`, `user_media`, `conversation_started`, etc. — not Messenger-specific types like `quick_reply`, `postback`, `messaging_optins`
- Remove Messenger-specific assumptions from state machine logic (e.g., PSID handling, quick_reply payload parsing, postback detection)
- The adapter layer lives in replybot but is cleanly separated from the core (separate module/directory)

**What doesn't change**:
- The adapter still lives within the replybot process (not a separate service)
- Kafka topic structure stays the same
- State persistence format stays the same

**Key insight**: The rust branch's `machine-core` had this exact separation. The `statestore.rs` module parsed Messenger events into `UniversalEvent` types, and the state machine (`exec.rs`) only worked with abstract events. We can follow the same pattern in Node.js.

**Key risk**: Messenger-specific assumptions may be deeply embedded in the state machine logic, not just in event parsing. Need thorough investigation of `machine.js` `exec()` to identify all platform-specific code paths (e.g., postback handling, quick_reply payload format, attachment types, optin events).

**Done when**: The state machine's `exec()` and `apply()` functions have no Messenger-specific imports or logic. A new platform's events could be fed to the state machine by writing only a new adapter — no core changes needed.

---

## Phase 4: WhatsApp End-to-End

**Goal**: Users on WhatsApp can complete surveys, with the same experience as Messenger users.

**What changes**:

**Inbound (webhook → state machine)**:
- Botserver (or a new adapter within replybot) receives WhatsApp Cloud API webhooks
- Normalizes WhatsApp events to the same platform-agnostic format as Messenger events
- WhatsApp event types map to agnostic types: `text` → `user_text`, `interactive.button_reply` → `user_choice`, `image` → `user_media`, etc.

**Outbound (commands → WhatsApp API)**:
- Message-worker's WhatsApp translation logic already exists (`TranslateToWhatsApp()` — 10 tests on the rust branch)
- Implement the WhatsApp Cloud API client (stub exists, needs real implementation)
- WhatsApp has different constraints: buttons (≤3), lists (4-10 options), no quick_replies
- Token/credential management for WhatsApp Business accounts

**Platform routing**:
- Commands include a `platform` field (already in `SendMessageCommand`)
- Message-worker routes to the correct client based on platform
- Replybot needs to know which platform a user is on (from the inbound event) and include it in outbound commands

**What doesn't change**:
- State machine core logic (it's platform-agnostic after phase 3)
- Kafka topic structure
- Existing Messenger functionality

**Key risks**:
- WhatsApp message limits (24-hour window, template messages outside window)
- WhatsApp webhook verification is different from Messenger
- User identity: WhatsApp uses phone numbers, Messenger uses PSIDs
- Media handling differences (WhatsApp requires media IDs, not just URLs)

**Done when**: A user can complete a survey on WhatsApp from referral to completion. Message-worker correctly translates and sends via WhatsApp Cloud API. Errors are reported and handled.

---

## Dependencies Between Phases

```
Phase 1 ──→ Phase 2 ──→ Phase 3 ──→ Phase 4
                              │            │
                              └────────────┘
                              Both required
                              for WhatsApp
```

- **Phase 2 depends on Phase 1**: Can't emit agnostic commands until the worker is in place
- **Phase 3 depends on Phase 2**: Outbound should be agnostic before inbound (otherwise replybot is agnostic on input but Messenger-specific on output — inconsistent)
- **Phase 4 depends on Phase 2 + 3**: WhatsApp needs both agnostic inbound and agnostic outbound

Phases are sequential — each builds on the previous. No parallelism between phases, but work within a phase can be parallelized.

---

## What We're Reusing from the Rust Branch

The `feat/rust-replybot-migration` branch has battle-tested code we bring over incrementally:

| Component | Phase | What we reuse |
|-----------|-------|---------------|
| `message-worker/` (Go) | 1 | Entire service: Kafka consumer, retry logic, error reporting, Dockerfile, Helm chart |
| `burrow/` (Go) | 1 | Kafka consumer library with at-least-once guarantees |
| `TranslateToMessenger()` | 2 | Messenger translation logic (26 tests) |
| `TranslateToWhatsApp()` | 4 | WhatsApp translation logic (10 tests) |
| `TranslateToInstagram()` | Future | Instagram translation logic (8 tests) |
| `machine-core` event parsing patterns | 3 | Architecture reference for platform-agnostic event normalization |
| `botserver-core` WhatsApp adapter | 4 | Reference for WhatsApp webhook verification and parsing |

**What we don't reuse**: The Rust state machine (`machine-core`), Rust event processor (`machine`), or `vlab-types`. The Node.js replybot state machine stays — we refactor it in place rather than replacing it.

---

## What's NOT in This Roadmap

- **External-worker extraction** — Dinersclub (payments) is already a separate service. No need to extract.
- **Rust state machine replacement** — We're refactoring replybot's Node.js state machine, not replacing it with Rust.
- **Instagram support** — Future work after WhatsApp. Same pattern: add adapters on inbound + outbound.
- **Telegram support** — Not in scope.
- **getUserInfo extraction** — Stays in replybot as a synchronous Facebook API call. Not worth the complexity of async extraction.
