# Message Worker Extraction - Step 3 Completion Summary

## Overview

Successfully completed Step 3 of the message-worker extraction: Modified replybot to publish message commands to Kafka instead of calling the Facebook API directly.

## Changes Implemented

### 3a. Modified `replybot/lib/typewheels/transition.js`

**Changes to Machine class:**

1. **Imports**: Removed `sendMessage` and `passThreadControl` imports. Kept `getUserInfo`. Added `MachineIOError` back for proper error handling. Added `crypto` for ID generation.

2. **Constructor**: Removed assignments of `this.sendMessage` and `this.passThreadControl` since these are no longer called.

3. **`act()` method**: Changed from async method that calls Facebook API to a pure function that simply returns the messages array.

4. **Removed `handoff()` method**: Deleted the async method that called passThreadControl. Handoff is now handled via Kafka commands.

5. **Added `buildCommands()` method**: New pure function that transforms messages and optional handoff into Kafka command objects.
   - Generates unique `command_id` using `crypto.randomBytes(8).toString('hex')`
   - Sets `issued_at` timestamp
   - Includes conversation/user IDs and platform metadata
   - For messages: `type: 'native'` with `native_payload` containing the pre-formatted Facebook message
   - For handoff: `type: 'pass_thread_control'` with `target_app_id` and `handoff_metadata`

6. **Modified `run()` method**: Updated to work with commands instead of calling Facebook API
   - Calls `act()` to get messages (synchronous)
   - Calls `buildCommands()` to create Kafka command objects
   - Returns `commands` in the report instead of `actions` and `handoff`
   - Preserved MachineIOError handling for internal errors

### 3b. Modified `replybot/lib/index.js`

1. **Added environment variable**: `KAFKA_COMMANDS_TOPIC` with default value 'commands'

2. **Added `publishCommands()` function**: New function that publishes an array of commands to Kafka
   - Uses `produce()` helper with `user_id` as partition key

3. **Updated processor function**: Added command publishing after state/response/payment publishing

### 3c. Cleaned up `replybot/lib/messenger/index.js`

1. Removed `MachineIOError` import
2. Simplified `facebookRequest()` error handling
3. Deleted `sendMessage()` function
4. Deleted `passThreadControl()` function
5. Kept `getUserInfo()` function (still needed)
6. Updated module exports to only export `{ getUserInfo }`

### 3d. Updated test files

**`replybot/lib/typewheels/transition.test.js`:**
- Removed tests for `MachineIOError` thrown by `act()`
- Updated assertions to check for `commands` array with proper structure
- Updated handoff tests to verify `pass_thread_control` command generation
- Result: 327 passing tests

**`replybot/lib/messenger/messenger.test.js`:**
- Removed all tests for `sendMessage()` and `passThreadControl()`
- Kept test for `getUserInfo()` error handling

### 3e. Updated documentation

**`replybot/README.md`:**
- Added new "Message Command Publisher" section
- Documented the new architecture and command format
- Added JSON examples of commands
- Documented the `KAFKA_COMMANDS_TOPIC` environment variable

## Test Results

327 passing (up from 326)
1 pending
1 failing (pre-existing socket issue in nock, unrelated to changes)

## Architectural Changes

**Before**: Replybot synchronously sent messages to Facebook API, blocking event processing

**After**: Replybot publishes message commands to Kafka; message-worker service handles delivery

This enables:
- Non-blocking event processing in replybot
- Retry logic independent of replybot
- Error handling via synthetic events from botserver
- Easier platform expansion (new message-worker translators for WhatsApp, Instagram, etc.)

## Key Design Decisions

1. **ID Generation**: Used `crypto.randomBytes(8).toString('hex')` for unique command IDs
2. **Native Passthrough**: Phase 1 uses pre-formatted Facebook payloads, no translation needed
3. **Error Handling**: Internal errors (getForm, getPageToken) preserved as MachineIOError; message delivery errors flow through botserver
4. **Partition Key**: User ID ensures per-user message ordering
