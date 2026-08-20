package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"time"

	"github.com/cenkalti/backoff"
	"github.com/confluentinc/confluent-kafka-go/v2/kafka"
	"github.com/dgraph-io/ristretto"
	"github.com/go-playground/validator/v10"
	"github.com/jackc/pgx/v4/pgxpool"
	"github.com/nandanrao/chance"
	"github.com/vlab-research/botparty"
	"github.com/vlab-research/spine"
)

type DC struct {
	cfg         *Config
	pool        *pgxpool.Pool
	botparty    *botparty.BotParty
	cache       *ristretto.Cache
	getProvider GetProvider
}

type GetProvider func(pool *pgxpool.Pool, event *PaymentEvent) (Provider, error)

func handle(err error) {
	if err != nil {
		log.Fatal(err)
	}
}

func (dc *DC) Process(messages []*kafka.Message) error {
	tasks := []interface{}{}
	errs := []error{}

	for _, m := range messages {
		pe := new(PaymentEvent)
		err := json.Unmarshal(m.Value, pe)
		if err != nil {
			// Collect and carry on, do NOT return here. spine commits the
			// batch once checkError has seen the result, so returning early
			// used to abandon every message after this one -- silently, and
			// with the offset moving past them. That was invisible only
			// because checkError called log.Fatalf and the pod died before
			// the commit; it stopped being invisible the moment it didn't.
			//
			// Wrap with %w, not %s. This error carries a concrete type that
			// the package elsewhere inspects to distinguish a malformed
			// payload from a system fault (see reloadly.go's
			// *json.SyntaxError branch, which maps it to a user-facing
			// JSON_SYNTAX_ERROR instead of retrying). Formatting the error
			// with %s flattens it to an opaque *errors.errorString and
			// silently breaks errors.As/errors.Is for every caller --
			// including errors.Join below, which preserves the chain.
			recordFault("parse")
			errs = append(errs, fmt.Errorf("Error parsing kakfa message: %s. Error: %w", string(m.Value), err))
			continue
		}
		tasks = append(tasks, pe)
	}

	// this processes them all at once
	// maybe better for providers to have
	// a fixed pool size, limit concurrent
	// requests
	outch := chance.Pool(dc.cfg.PoolSize, chance.Flatten(tasks), dc.Work)

	// Drain outch to completion. Returning mid-range leaves the pool's
	// goroutines blocked forever on a send nobody is receiving -- a leak per
	// failed message, which again only stayed hidden while the process died
	// on the first error.
	for x := range outch {
		if err, ok := x.(error); ok {
			errs = append(errs, err)
		}
	}

	return errors.Join(errs...)
}

func backoffTime(d time.Duration, r float64) *backoff.ExponentialBackOff {
	ebo := backoff.NewExponentialBackOff()
	ebo.RandomizationFactor = r
	ebo.MaxElapsedTime = d
	return ebo
}

func (dc *DC) sendResult(pe *PaymentEvent, res *Result) error {
	b, err := json.Marshal(res)
	jm := json.RawMessage(b)
	if err != nil {
		e := fmt.Errorf("Error marshalling result into json: %s. Error: %s", res.Error, err)
		return e
	}

	op := func() error {
		ee := botparty.NewExternalEvent(pe.Userid, pe.Pageid, "external", &jm)
		return dc.botparty.Send(ee)
	}

	if err := backoff.Retry(op, backoffTime(dc.cfg.RetryBotserver, dc.cfg.BackOffRandomFactor)); err != nil {
		recordFault("send")
		return err
	}
	return nil
}

// TODO: this result does not provide the ID from the PaymentEvent Details (not yet marshalled)
//
//	and thus cannot actually show the result to the user and causes the system to get stuck.
//	waiting an external event forever that never comes.
func invalidProviderResult(pe *PaymentEvent) *Result {
	message := fmt.Sprintf("You requested payment by provider: %v but no provider with that name is configured", pe.Provider)
	err := &PaymentError{message, "INVALID_PROVIDER", nil}
	t := fmt.Sprintf("payment:%v", pe.Provider)
	res := &Result{Type: t, Success: false, Timestamp: time.Now().UTC(), Error: err}
	return res
}

func authError(pe *PaymentEvent, e error) *Result {
	message := fmt.Sprint(e)
	err := &PaymentError{message, "AUTH_ERROR", nil}
	t := fmt.Sprintf("payment:%v", pe.Provider)
	res := &Result{Type: t, Success: false, Timestamp: time.Now().UTC(), Error: err}
	return res
}

func (dc *DC) checkCache(provider Provider, pe *PaymentEvent, user *User) (Provider, error) {

	// add key, provider + key + user.Id = key
	key := pe.Provider + pe.Key + user.Id
	p, ok := dc.cache.Get(key)
	if ok {
		return p.(Provider), nil
	}
	e := provider.Auth(user, pe.Key) // also add key
	if e != nil {
		return nil, e
	}

	dc.cache.SetWithTTL(key, provider, 1, dc.cfg.CacheTTL)
	return provider, nil
}

// transientResultError makes a transient failure Result visible to
// backoff.Retry. The providers report a declined payment as (Result, nil) --
// only a system fault comes back as a non-nil error -- so without this the
// retry budget never applied to the one class of failure it exists for. A
// provider answering 503 for a minute burned straight through the queue,
// telling every respondent behind it that their payment had failed.
type transientResultError struct {
	res *Result
}

func (e *transientResultError) Error() string {
	if e.res == nil || e.res.Error == nil {
		return "transient provider failure"
	}
	return fmt.Sprintf("transient provider failure: %s (%s)", e.res.Error.Code, e.res.Error.Message)
}

// payout runs provider.Payout under the retry budget.
//
// It returns (res, nil) whenever a verdict was reached, including a transient
// one that outlived the budget -- the caller decides what to do with it. It
// returns (nil, err) only when no verdict exists at all, i.e. every attempt
// failed as a system fault.
func (dc *DC) payout(provider Provider, pe *PaymentEvent) (*Result, error) {
	var res *Result
	start := time.Now()

	op := func() error {
		r, err := provider.Payout(pe)
		if err != nil {
			return err
		}
		if r == nil {
			// A provider that answers (nil, nil) has told us nothing. The
			// fake provider does exactly this when a payment carries no
			// `result` block, and treating it as a verdict would dereference
			// nil here and marshal "null" onto the wire below.
			return fmt.Errorf("provider %s returned no result and no error", pe.Provider)
		}
		res = r
		if !r.Success {
			if recovery, _ := ClassifyResult(r); recovery == RecoveryTransient {
				return &transientResultError{r}
			}
		}
		return nil
	}

	err := backoff.Retry(op, backoffTime(dc.cfg.RetryProvider, dc.cfg.BackOffRandomFactor))
	observePayout(pe, res, time.Since(start))

	if err != nil && res == nil {
		return nil, err
	}
	return res, nil
}

// deliver files the outcome and decides whether the respondent hears about it.
//
// A permanent failure is sent, exactly as every failure was sent before this
// change. A transient or precondition failure is withheld, which leaves the
// respondent in WAIT_EXTERNAL_EVENT so dean's Payments sweep re-drives the
// payment -- for up to 14 days, which is long enough for a provider to come
// back or a researcher to top up a wallet. Sending would end that: the wait
// matcher does not look at `success`, so ANY Result releases them and dean
// stops re-driving. See planning/payment-failure-handling.md §0.1.
//
// The failure is not lost by staying silent, it is recorded in metrics.go
// instead of in the respondent's state. That is the whole trade.
func (dc *DC) deliver(pe *PaymentEvent, res *Result) error {
	if res == nil {
		recordFault("deliver")
		return fmt.Errorf("nothing to deliver for user %s: no result was produced", pe.Userid)
	}

	recordResult(pe, res)

	if res.Success {
		return dc.sendResult(pe, res)
	}

	recovery, known := ClassifyResult(res)
	code := ""
	if res.Error != nil {
		code = res.Error.Code
	}

	if !known {
		log.Printf("DinersClub saw an unclassified %s error code %q for user %s -- treating it as permanent and telling the respondent. Add it to recoveryByCode in classify.go.",
			pe.Provider, code, pe.Userid)
	}

	if recovery.Silent() {
		log.Printf("DinersClub withholding %s failure for user %s: code=%s recovery=%s. Respondent stays in WAIT_EXTERNAL_EVENT; dean will re-drive the payment.",
			pe.Provider, pe.Userid, code, recovery)
		return nil
	}

	return dc.sendResult(pe, res)
}

func (dc *DC) Job(pe *PaymentEvent) error {
	validate := validator.New()
	err := validate.Struct(pe)
	if err != nil {
		recordFault("validate")
		return err
	}

	if !contains(dc.cfg.Providers, pe.Provider) {
		return dc.deliver(pe, invalidProviderResult(pe))
	}

	provider, err := dc.getProviderFromEvent(pe)
	if provider == nil {
		return dc.deliver(pe, invalidProviderResult(pe))
	}
	if err != nil {
		recordFault("provider")
		return err
	}

	user, err := provider.GetUserFromPaymentEvent(pe)
	if user == nil {
		recordFault("user")
		return fmt.Errorf(`User not found for page id: %s`, pe.Pageid)
	}
	if err != nil {
		recordFault("user")
		return err
	}

	// An auth failure is a payment outcome, not a fault: AUTH_ERROR is a
	// precondition, so deliver withholds it and the respondent waits while a
	// researcher restores the credential.
	provider, e := dc.checkCache(provider, pe, user)
	if e != nil {
		return dc.deliver(pe, authError(pe, e))
	}

	res, err := dc.payout(provider, pe)
	if err != nil {
		// No verdict at all -- every attempt was a system fault. Nothing is
		// sent, so the respondent stays parked and dean re-drives.
		recordFault("payout")
		return err
	}

	return dc.deliver(pe, res)
}

func (dc *DC) Work(i interface{}) interface{} {
	pe := i.(*PaymentEvent)
	return dc.Job(pe)
}

func contains(s []string, target string) bool {
	for _, x := range s {
		if x == target {
			return true
		}
	}
	return false
}

func (dc *DC) getProviderFromEvent(event *PaymentEvent) (Provider, error) {
	return dc.getProvider(dc.pool, event)
}

func getProvider(pool *pgxpool.Pool, event *PaymentEvent) (Provider, error) {
	switch event.Provider {
	case "fake":
		return NewFakeProvider(getUserFromFakePaymentEvent, auth)
	case "reloadly":
		return NewReloadlyProvider(pool)
	case "giftcard":
		return NewGiftCardsProvider(pool)
	case "http":
		return NewHttpProvider(pool)
	case "dingconnect":
		return NewDingConnectProvider(pool)
	}
	return nil, nil
}

func monitor(errs <-chan error) {
	e := <-errs
	log.Fatalf("DinersClub failed from Kafka error: %v", e)
}

// checkError handles a fault from Process. It deliberately does NOT exit.
//
// spine commits the batch immediately after this returns, so log.Fatalf was
// the only thing standing between a fault and a lost message -- and it bought
// that at the price of never committing anything. On 2026-08-17 that turned a
// hung Reloadly into a crash loop that made zero progress for ~50 minutes:
// the batch was never committed, the pod restarted, read the same two
// messages, and hung again.
//
// Committing past a fault is safe here because nothing was sent to the
// respondent. They are still parked in WAIT_EXTERNAL_EVENT, and dean's
// Payments sweep re-drives the payment for up to 14 days. dinersclub is not
// the last line of defence and must not behave as though it is.
//
// monitor() still exits, because a Kafka fault is not this: the consumer has
// lost its group and nothing further will be processed anyway.
func checkError(err error) {
	log.Printf("DinersClub processing error (batch committed; respondents stay parked and dean will re-drive): %v", err)
}

func main() {
	cfg := getConfig()
	pool := getPool(cfg)
	bp := botparty.NewBotParty(cfg.Botserver)
	cache, err := ristretto.NewCache(&ristretto.Config{
		NumCounters: cfg.CacheNumCounters,
		MaxCost:     cfg.CacheMaxCost,
		BufferItems: cfg.CacheBufferItems,
	})
	handle(err)
	dc := &DC{cfg, pool, bp, cache, getProvider}

	// Metrics are how a withheld failure stays accountable -- see metrics.go.
	go serveMetrics(cfg.MetricsPort)

	c := spine.NewKafkaConsumer(cfg.KafkaTopic, cfg.KafkaBrokers, cfg.KafkaGroup,
		cfg.KafkaPollTimeout, cfg.KafkaBatchSize, cfg.KafkaBatchSize)

	errs := make(chan error)
	go monitor(errs)

	for {
		c.SideEffect(dc.Process, checkError, errs)
	}
}
