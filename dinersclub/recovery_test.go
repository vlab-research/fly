package main

import (
	"fmt"
	"io/ioutil"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/dgraph-io/ristretto"
	"github.com/jackc/pgx/v4/pgxpool"
	"github.com/stretchr/testify/assert"
)

// Behaviour of the recovery classes end to end, through Process.
//
// These tests are about ONE question: does the respondent hear about this
// failure? That question is decided entirely by whether a Result reaches the
// botserver, because waiting.js matches a wait on type+id and ignores
// `success` -- so a delivered Result releases the respondent from
// WAIT_EXTERNAL_EVENT whatever it says, and an undelivered one leaves them
// parked for dean. See planning/external-event-taxonomy.md §1.
//
// Every assertion here is therefore a count of botserver calls, not an
// assertion about a field. Asserting on the body inside the handler would pass
// vacuously when nothing is sent -- the handler simply never runs -- which is
// exactly the trap the old TestDinersClubAuthError fell into.

// countingBotserver returns a server that records how many results it received
// and the last body it saw.
func countingBotserver(received *int32, last *string) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		data, _ := ioutil.ReadAll(r.Body)
		*last = strings.TrimSpace(string(data))
		atomic.AddInt32(received, 1)
		w.WriteHeader(200)
	}))
}

// failingPaymentMessage builds a fake-provider payment whose Result is a
// failure carrying the given provider error code.
func failingPaymentMessage(code string) string {
	return fmt.Sprintf(`{
		"userid": "foo",
		"pageid": "page",
		"timestamp": 1600558963867,
		"provider": "fake",
		"details": {
			"result": {
				"type": "payment:fake",
				"id": "payment-1",
				"success": false,
				"error": {"message": "provider said no", "code": %q}
			}
		}
	}`, code)
}

func TestPermanentFailureReachesTheRespondent(t *testing.T) {
	var received int32
	var last string
	ts := countingBotserver(&received, &last)
	defer ts.Close()

	// IMPOSSIBLE_AMOUNT: the survey's payment block cannot pay this person,
	// and no retry changes that. Releasing them beats a silent 14-day park.
	err := getDC(ts).Process(makeMessages([]string{failingPaymentMessage("IMPOSSIBLE_AMOUNT")}))

	assert.Nil(t, err)
	assert.Equal(t, int32(1), atomic.LoadInt32(&received))
	assert.Contains(t, last, `"code":"IMPOSSIBLE_AMOUNT"`)
	assert.Contains(t, last, `"success":false`)
}

func TestPreconditionFailureIsWithheld(t *testing.T) {
	var received int32
	var last string
	ts := countingBotserver(&received, &last)
	defer ts.Close()

	// The researcher's wallet is empty. Nothing is sent, so the respondent
	// stays in WAIT_EXTERNAL_EVENT and dean re-drives the payment once the
	// wallet is topped up -- which is the entire point.
	err := getDC(ts).Process(makeMessages([]string{failingPaymentMessage("INSUFFICIENT_BALANCE")}))

	assert.Nil(t, err)
	assert.Equal(t, int32(0), atomic.LoadInt32(&received),
		"an empty wallet must never be reported to the respondent")
}

func TestTransientFailureIsRetriedThenWithheld(t *testing.T) {
	var received int32
	var last string
	ts := countingBotserver(&received, &last)
	defer ts.Close()

	// A provider 500 used to drain the queue as a respondent-facing failure:
	// go-reloadly synthesises an APIError from ANY non-2xx and formatError
	// hands it back as (Result, nil), so the retry budget never saw it. Now
	// payout retries it, and when the budget runs out nothing is sent.
	err := getDC(ts).Process(makeMessages([]string{failingPaymentMessage("500")}))

	assert.Nil(t, err)
	assert.Equal(t, int32(0), atomic.LoadInt32(&received))
}

func TestTransientFailureIsActuallyRetried(t *testing.T) {
	var received int32
	var last string
	ts := countingBotserver(&received, &last)
	defer ts.Close()

	// Counting Payout calls is the only way to see the retry: a withheld
	// failure looks identical to a never-attempted one from outside.
	var attempts int32
	getProvider := func(pool *pgxpool.Pool, event *PaymentEvent) (Provider, error) {
		return &countingProvider{attempts: &attempts}, nil
	}

	dc := getDC(ts)
	dc.getProvider = getProvider

	err := dc.Process(makeMessages([]string{failingPaymentMessage("503")}))

	assert.Nil(t, err)
	assert.Greater(t, atomic.LoadInt32(&attempts), int32(1),
		"a transient provider failure must be retried inside the budget")
	assert.Equal(t, int32(0), atomic.LoadInt32(&received))
}

func TestPermanentFailureIsNotRetried(t *testing.T) {
	var received int32
	var last string
	ts := countingBotserver(&received, &last)
	defer ts.Close()

	// The mirror of the test above, and the reason the classifier has to be
	// right in both directions: retrying a permanent failure burns the whole
	// budget on a call that cannot succeed, which is how a batch outruns the
	// Kafka poll interval.
	var attempts int32
	dc := getDC(ts)
	dc.getProvider = func(pool *pgxpool.Pool, event *PaymentEvent) (Provider, error) {
		return &countingProvider{attempts: &attempts}, nil
	}

	err := dc.Process(makeMessages([]string{failingPaymentMessage("INVALID_RECIPIENT_PHONE")}))

	assert.Nil(t, err)
	assert.Equal(t, int32(1), atomic.LoadInt32(&attempts))
	assert.Equal(t, int32(1), atomic.LoadInt32(&received))
}

func TestUnclassifiedCodeReachesTheRespondent(t *testing.T) {
	var received int32
	var last string
	ts := countingBotserver(&received, &last)
	defer ts.Close()

	// An unknown code defaults to permanent, i.e. to exactly the behaviour
	// every failure had before classification existed. New behaviour applies
	// only where we can name the reason.
	err := getDC(ts).Process(makeMessages([]string{failingPaymentMessage("A_CODE_NOBODY_HAS_SEEN")}))

	assert.Nil(t, err)
	assert.Equal(t, int32(1), atomic.LoadInt32(&received))
	assert.Contains(t, last, "A_CODE_NOBODY_HAS_SEEN")
}

func TestAuthFailureIsWithheld(t *testing.T) {
	var received int32
	var last string
	ts := countingBotserver(&received, &last)
	defer ts.Close()

	// REPLACES the old assertion that an auth failure is reported to the
	// respondent. AUTH_ERROR is a precondition: the researcher's credential
	// stopped working, the respondent cannot help, and a re-authorisation
	// inside dean's window pays everyone who was parked.
	//
	// Note the shape of this test. The old one asserted on the request body
	// inside the handler, which meant that once nothing was sent it passed
	// without running a single assertion.
	failAuth := func(user *User, key string) error {
		return fmt.Errorf(`No credentials were found for user: %s`, user.Id)
	}
	getProvider := func(pool *pgxpool.Pool, event *PaymentEvent) (Provider, error) {
		getUser := func(event *PaymentEvent) (*User, error) {
			return &User{Id: "bad-user"}, nil
		}
		return NewFakeProvider(getUser, failAuth)
	}

	cfg := getConfig()
	cache, _ := ristretto.NewCache(&ristretto.Config{
		NumCounters: cfg.CacheNumCounters,
		MaxCost:     cfg.CacheMaxCost,
		BufferItems: cfg.CacheBufferItems,
		Metrics:     true,
	})
	cache.Clear()
	dc := &DC{
		cfg,
		getPool(cfg),
		NewHTTPPoster(ts.URL),
		cache,
		getProvider,
	}

	err := dc.Process(makeMessages([]string{`{
		"userid": "bad-user",
		"pageid": "page",
		"provider": "fake",
		"timestamp": 1600558963867,
		"details": {"result": {"type": "foo", "success": true}}
	}`}))

	assert.Nil(t, err)
	assert.Equal(t, int32(0), atomic.LoadInt32(&received),
		"a dead credential is not the respondent's problem to hear about")
}

func TestMalformedMessageDoesNotAbandonTheRestOfTheBatch(t *testing.T) {
	var received int32
	var last string
	ts := countingBotserver(&received, &last)
	defer ts.Close()

	// Process used to `return` on the first parse failure. spine commits the
	// batch regardless once checkError has seen the result, so every message
	// after the bad one was silently skipped AND committed. That only stayed
	// invisible while checkError called log.Fatalf and the pod died first.
	msgs := makeMessages([]string{
		`{"userid": "foo", "pageid": "page", "timestamp"---> broken <---`,
		`{
			"userid": "bar",
			"pageid": "page",
			"timestamp": 1600558963867,
			"provider": "fake",
			"details": {"result": {"type": "payment:fake", "success": true}}
		}`,
	})

	err := getDC(ts).Process(msgs)

	assert.NotNil(t, err, "the parse failure must still be reported")
	assert.Equal(t, int32(1), atomic.LoadInt32(&received),
		"the good message in the batch must still be paid")
}

// countingProvider records how many times Payout was called and echoes the
// Result embedded in the payment details, like the fake provider.
type countingProvider struct {
	attempts *int32
}

func (p *countingProvider) GetUserFromPaymentEvent(event *PaymentEvent) (*User, error) {
	return &User{Id: "test-id"}, nil
}

func (p *countingProvider) Auth(user *User, key string) error { return nil }

func (p *countingProvider) Payout(event *PaymentEvent) (*Result, error) {
	atomic.AddInt32(p.attempts, 1)
	fake, err := NewFakeProvider(p.GetUserFromPaymentEvent, p.Auth)
	if err != nil {
		return nil, err
	}
	return fake.Payout(event)
}

// A provider that answers (nil, nil) has told us nothing. The fake provider
// does exactly this when a payment carries no `result` block. Before
// classification it marshalled to "null" and was sent to the botserver as a
// Result; it must now be a fault, not a verdict, and above all must not panic
// on the nil dereference that reading its recovery class would require.
func TestProviderWithNoResultIsAFaultNotAVerdict(t *testing.T) {
	var received int32
	var last string
	ts := countingBotserver(&received, &last)
	defer ts.Close()

	err := getDC(ts).Process(makeMessages([]string{`{
		"userid": "foo",
		"pageid": "page",
		"timestamp": 1600558963867,
		"provider": "fake",
		"details": {}
	}`}))

	assert.NotNil(t, err)
	assert.Equal(t, int32(0), atomic.LoadInt32(&received))
}
