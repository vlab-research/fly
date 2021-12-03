package main

import (
	"encoding/json"
	"time"

	"github.com/go-playground/validator/v10"
	"github.com/vlab-research/go-reloadly/reloadly"
	"github.com/jackc/pgx/v4/pgxpool"
)

type GiftCardsProvider struct {
	ReloadlyProvider
}

func NewGiftCardsProvider(pool *pgxpool.Pool) (Provider, error) {
	cfg := getConfig()
	svc := reloadly.NewGiftCards()
	if cfg.Sandbox {
		svc.Sandbox()
	}
	p := ReloadlyProvider{pool, svc}
	return &GiftCardsProvider{p}, nil
}

func (p *GiftCardsProvider) formatError(res *Result, err error, details *json.RawMessage) (*Result, error) {
	res.Success = false

	// TODO: catch 500 errors and "try again later" errors
	// for retrying...
	// CARD_IS_NOT_READY
	// PENDING_OR_IN_PROGRESS
	// ORDER_IS_NOT_READY
	// IMPORT_CARD_ERROR
	if e, ok := err.(reloadly.APIError); ok {
		res.Error = &PaymentError{e.Message, e.ErrorCode, details}
		return res, nil
	}
	if e, ok := err.(reloadly.ReloadlyError); ok {
		res.Error = &PaymentError{e.Message, e.ErrorCode, details}
		return res, nil
	}
	if e, ok := err.(validator.ValidationErrors); ok {
		res.Error = &PaymentError{e.Error(), "INVALID_GIFT_CARD_DETAILS", details}
		return res, nil
	}

	// any other type of error should be considered a
	// system error and should be retried/logged.
	return res, err
}

func (p *GiftCardsProvider) Payout(event *PaymentEvent) (*Result, error) {
	order := new(reloadly.GiftCardOrder)
	err := json.Unmarshal(*event.Details, &order)
	if err != nil {
		return nil, err
	}

	result := &Result{}
	result.Type = "payment:reloadly-giftcard"
	result.ID = order.ID

	validate := validator.New()
	err = validate.Struct(order)
	if err != nil {
		return p.formatError(result, err, event.Details)
	}

	t, err := p.svc.GiftCards().Order(*order)
	if err != nil {
		return p.formatError(result, err, event.Details)
	}

	result.Success = true
	result.Timestamp = time.Time(*t.TransactionCreatedTime)
	result.PaymentDetails = event.Details
	return result, nil
}
