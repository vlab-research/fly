# Facebot Testrunner

Integration tests for the Fly chatbot system. Tests the complete flow from user messages through botserver, replybot, facebot, scribble, and dean.

## Architecture

The testrunner is a Kubernetes job that runs Mocha tests against a live cluster environment. It:

1. Seeds test forms into the CockroachDB database
2. Sends synthetic messages via the botserver
3. Polls the facebot mock server for outgoing messages
4. Validates the complete message flow including timeouts, follow-ups, and state transitions

### Components Tested

- **botserver**: Receives webhooks and synthetic events
- **replybot**: Message routing and form logic
- **facebot**: Mock Facebook API (gbv-facebot service)
- **scribble**: State persistence to CockroachDB
- **dean**: Timeout/follow-up/retry cron jobs

## Prerequisites

### Setting Up Local Development Cluster

If you don't have a running cluster:

```bash
cd devops
make dev
```

This creates a local kind cluster with all required services deployed.

### Verifying Cluster Access

```bash
# Check current context
kubectl config current-context

# Should show: kind-kind
# If not, switch to it:
kubectl config use-context kind-kind
```

## Running Tests

### Using dev.sh (Recommended)

```bash
cd facebot/testrunner
./dev.sh
```

This script does everything:
1. Deletes existing testrunner job
2. Builds Docker image
3. Pushes to local registry at `localhost:5000`
4. Applies Kubernetes job
5. Follows logs until completion

**This is the main way to run tests.** All development and testing should use this script.

### Manual Debugging (If dev.sh Fails)

```bash
# Check if registry is running
docker ps | grep registry

# Check if cluster is accessible
kubectl get pods

# Build without cache
docker build --no-cache -t localhost:5000/testrunner:registry .

# Check job status
kubectl get job testrunner
kubectl describe job testrunner

# View logs
kubectl logs -l app=testrunner --tail=100
```

## Test Configuration

### Critical: Dean Intervals

Dean cron jobs handle timeouts and follow-ups. **Integration tests require fast intervals**, otherwise tests will timeout waiting for messages.

**Correct configuration** in `devops/values/integrations/fly.yaml`:

```yaml
dean:
  env:
    - name: DEAN_SEND_DELAY
      value: "1ms"              # Fast message sending
    - name: DEAN_FOLLOWUP_MIN
      value: "1 minute"          # Minimum follow-up delay
    - name: DEAN_FOLLOWUP_MAX
      value: "1 hour"            # Maximum follow-up delay
```

**Wrong configuration** (will break tests):
```yaml
    - name: DEAN_FOLLOWUP_MIN
      value: "6 hours"           # ❌ Too long! Tests will timeout
    - name: DEAN_FOLLOWUP_MAX
      value: "24 hours"          # ❌ Too long! Tests will timeout
```

After changing dean configuration, redeploy:
```bash
cd devops
helm upgrade fly ./vlab -f values/integrations/fly.yaml
```

### Test Timeouts

- Most tests: 45 seconds
- Timeout tests: 180 seconds (3 minutes)
- Full test suite: ~8-10 minutes

## Writing Tests

### Learn From Existing Tests

The best way to understand how to write tests is to read the existing test code:

1. **Read `test.ts`**: Contains all test cases with different patterns
2. **Check `socket.ts`**: Understand `flowMaster` and `receive` functions
3. **Look at `forms/*.json`**: See how test forms are structured
4. **Study `sender.ts`**: Understand how messages are sent

### Basic Test Structure

Tests use the `flowMaster` pattern to orchestrate message exchanges:

```typescript
it('Test description', async () => {
  const userId = uuid();
  const fields = getFields('forms/FORMID.json');

  const testFlow: TestFlow = [
    [response, expectedMessage, userInputs],
    // ... more exchanges
  ];

  await sendMessage(makeReferral(userId, 'FORMID'));
  await flowMaster(userId, testFlow);
});
```

### TestFlow Format

Each array element represents one message exchange:

```typescript
[response, expectedMessage, userInputs, optionalRecipient]
```

- **response**: `ok` or `err` (defined in test.ts)
- **expectedMessage**: Field object or message shape to expect
- **userInputs**: Array of user messages to send after receiving
- **optionalRecipient**: Optional, for testing notify tokens

### Helper Functions

Available in `test.ts` and imported from `@vlab-research/mox`:

```typescript
// Message creation
makeReferral(userId, formId)              // Start form
makeTextResponse(userId, text)            // Text input
makeQR(field, userId, choiceIndex)        // Quick reply
makePostback(field, userId, choiceIndex)  // Button click
makeSynthetic(userId, event)              // External event
makeNotify(userId, metadata)              // Notify token

// Form utilities
getFields('forms/FORMID.json')            // Load form fields
makeRepeat(field, text)                   // Validation error
makeRepeated(field)                       // Mark as repeated
```

### Finding Test Patterns

To write tests for specific features:

1. **Search existing tests**: `grep -r "pattern" test.ts`
2. **Find similar forms**: Look in `forms/` for examples
3. **Check feature documentation**: See `documentation/` in the repo root
4. **Examine the codebase**:
   - Replybot logic: `replybot/src/`
   - Form configurations: Study working forms in `forms/`
   - Wait/timeout logic: Search for "wait" in test.ts

### Example: Testing a New Feature

1. Identify what you need to test (e.g., a new question type)
2. Find similar tests: `grep -A 20 "similar feature" test.ts`
3. Create a test form in `forms/` based on similar forms
4. Write test following the pattern you found
5. Run with `./dev.sh`

## Debugging Test Failures

### 1. Check Test Logs

```bash
kubectl logs -l app=testrunner --tail=200
```

### 2. Examine Database State

```bash
# Find test users
kubectl exec db-cockroachdb-0 -- ./cockroach sql --insecure --database=chatroach -e \
  "SELECT userid, current_state, current_form FROM states WHERE current_form LIKE '%FORMID%' ORDER BY updated DESC LIMIT 3;"

# Get detailed state
kubectl exec db-cockroachdb-0 -- ./cockroach sql --insecure --database=chatroach -e \
  "SELECT state_json::string FROM states WHERE userid = 'USER_ID';"

# Check responses
kubectl exec db-cockroachdb-0 -- ./cockroach sql --insecure --database=chatroach -e \
  "SELECT * FROM responses WHERE userid = 'USER_ID';"
```

### 3. Monitor Dean Processing

```bash
# List recent jobs
kubectl get jobs | grep dean-timeouts | tail -5

# Check logs
kubectl logs fly-dean-timeouts-JOBID-POD

# Verify configuration
kubectl describe cronjob fly-dean-timeouts | grep -A 20 "Environment"
```

### 4. Check Service Health

```bash
# Facebot (mock Facebook API)
kubectl get pods -l app=facebot
kubectl logs -l app=facebot --tail=50

# Botserver
kubectl logs -l app=botserver --tail=50

# Replybot
kubectl logs -l app=replybot --tail=50
```

## Common Issues

### Tests Timeout After 180 Seconds

**Root cause**: Dean intervals are too long

**Fix**:
1. Check `devops/values/integrations/fly.yaml`
2. Verify `DEAN_FOLLOWUP_MIN` is `"1 minute"` not `"6 hours"`
3. Redeploy: `helm upgrade fly ./vlab -f values/integrations/fly.yaml`
4. Rerun: `./dev.sh`

### Test Stuck Waiting for Message

**Symptoms**: Test hangs, `receive()` polls forever

**Debug steps**:
```bash
# Check facebot
kubectl get pods -l app=facebot

# Check user state (BLOCKED/ERROR?)
kubectl exec db-cockroachdb-0 -- ./cockroach sql --insecure --database=chatroach -e \
  "SELECT current_state, fb_error_code FROM states WHERE userid = 'USER_ID';"

# Verify form exists
kubectl exec db-cockroachdb-0 -- ./cockroach sql --insecure --database=chatroach -e \
  "SELECT shortcode FROM surveys WHERE shortcode = 'FORMID';"
```

### Docker Build Fails

```bash
# Check registry
curl http://localhost:5000/v2/_catalog

# Restart cluster if needed
cd devops
make clean
make dev
```

## Test Forms

Test forms are in `forms/*.json`. They are automatically seeded into the database when tests start.

### Adding a New Test Form

1. Create `forms/FORMID.json` following Typeform structure
2. Look at existing forms for examples
3. Test auto-seeds it on startup
4. Reference: `getFields('forms/FORMID.json')`

### Form Structure

Study existing forms to understand:
- Question types (statement, short_text, multiple_choice, etc.)
- Properties and validations
- Custom messages
- Hidden fields
- Wait configurations

Form naming: Use Typeform ID as filename (e.g., `forms/abc123XY.json`)

## Development Workflow

1. Make changes to `test.ts` or form JSONs
2. Run `./dev.sh` to rebuild and test
3. Check logs if tests fail
4. Query database to understand state
5. Iterate

**Important**: Tests must run in Kubernetes via `./dev.sh`. There is no local mode because tests require the full stack (botserver, replybot, facebot, scribble, dean, database).

## CI/CD

Tests run as a Kubernetes Job. Exit code 0 = success.

Job configuration: `facebot/kube/job.yaml`

For CI:
```bash
cd devops
make integration-tests
```

## Learning Resources

- **test.ts**: All test patterns and examples
- **socket.ts**: Core test infrastructure (`flowMaster`, `receive`)
- **forms/**: Example form configurations
- **documentation/**: Feature documentation in repo root
- **@vlab-research/mox**: Message creation helpers (check node_modules or source)
