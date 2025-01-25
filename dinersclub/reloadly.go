package main

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/go-playground/validator/v10"
	"github.com/jackc/pgx/v4"
	"github.com/jackc/pgx/v4/pgxpool"
	"github.com/vlab-research/go-reloadly/reloadly"
)

type ReloadlyProvider struct {
	pool      *pgxpool.Pool
	svc       *reloadly.Service
	valErrMsg string
}

func NewReloadlyProvider(pool *pgxpool.Pool) (Provider, error) {
	cfg := getConfig()
	svc := reloadly.NewTopups()
	if cfg.Sandbox {
		svc.Sandbox()
	}
	return &ReloadlyProvider{pool, svc, "INVALID_PAYMENT_DETAILS"}, nil
}

func (p *ReloadlyProvider) formatError(res *Result, err error, details *json.RawMessage) (*Result, error) {
	res.Success = false

	// TODO: catch 500 errors and "try again later" errors
	// for retrying...
	// TOPUPS ERRORS
	// - PHONE_RECENTLY_RECHARGED
	// - TRANSACTION_CANNOT_BE_PROCESSED_AT_THE_MOMENT
	// - PROVIDER_INTERNAL_ERROR
	// - SERVICE_TO_OPERATOR_TEMPORARILY_UNAVAILABLE
	// GIFT CARDS ERRORS
	// - CARD_IS_NOT_READY
	// - PENDING_OR_IN_PROGRESS
	// - ORDER_IS_NOT_READY
	// - IMPORT_CARD_ERROR

	// what to do if fallback is not provider you checked
	// has correct option types?

	// IMPOSSIBLE_AMOUNT
	// Add special message in typeform logic to deal with this???
	if e, ok := err.(reloadly.APIError); ok {
		res.Error = &PaymentError{e.Message, e.ErrorCode, details}
		return res, nil
	}
	if e, ok := err.(reloadly.ReloadlyError); ok {
		res.Error = &PaymentError{e.Message, e.ErrorCode, details}
		return res, nil
	}
	if e, ok := err.(validator.ValidationErrors); ok {
		res.Error = &PaymentError{e.Error(), p.valErrMsg, details}
		return res, nil
	}
	if e, ok := err.(*json.SyntaxError); ok {
		res.Error = &PaymentError{fmt.Sprintf(`We had an unknown issue with the mobile topups service. Please try again later. Error: %s.`, e.Error()), "JSON_SYNTAX_ERROR", details}
		return res, nil
	}

	// any other type of error should be considered a
	// system error and should be retried/logged.
	return res, err
}

func (p *ReloadlyProvider) GetUserFromPaymentEvent(event *PaymentEvent) (*User, error) {
	return GenericGetUser(p.pool, event)
}

func (p *ReloadlyProvider) Auth(user *User, key string) error {
	if key == "" {
		return fmt.Errorf(`No key provided for Reloadly provider. A key is required for Reloadly Payment Events!`)
	}

	crds, err := p.getCredentials(user.Id, key)
	if err != nil {
		return err
	}
	if crds == nil {
		return fmt.Errorf(`No reloadly credentials were found for user: %s`, user.Id)
	}

	auth := struct {
		Id     string `json:"id"`
		Secret string `json:"secret"`
	}{}
	err = json.Unmarshal(*crds.Details, &auth)
	if err != nil {
		return err
	}

	return p.svc.Auth(auth.Id, auth.Secret)
}

func (p *ReloadlyProvider) getCredentials(userid string, key string) (*Credentials, error) {
	query := `SELECT details FROM credentials WHERE entity='reloadly' AND userid=$1 AND key=$2 LIMIT 1`
	row := p.pool.QueryRow(context.Background(), query, userid, key)
	var c Credentials
	err := row.Scan(&c.Details)

	if err == pgx.ErrNoRows {
		return nil, nil
	}

	return &c, err
}

func (p *ReloadlyProvider) Payout(event *PaymentEvent) (*Result, error) {
	job := new(reloadly.TopupJob)
	err := json.Unmarshal(*event.Details, &job)
	if err != nil {
		e := fmt.Errorf("Error unmarshalling from json: %s. Error: %s", string(*event.Details), err)
		return nil, e
	}

	result := &Result{}
	result.Type = "payment:reloadly"
	result.ID = job.ID

	validate := validator.New()
	err = validate.Struct(job)
	if err != nil {
		return p.formatError(result, err, event.Details)
	}

	worker := reloadly.TopupWorker(*p.svc)
	r, err := worker.DoJob(job)
	if err != nil {
		return p.formatError(result, err, event.Details)
	}

	// TODO:
	// json.Marshal r to add response to result

	result.Success = true
	result.Timestamp = time.Time(*r.TransactionDate)
	result.PaymentDetails = event.Details
	return result, nil
}
