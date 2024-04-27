package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"

	"net/http"
	"net/http/httputil"
	"strings"
	"time"

	"github.com/alexkappa/mustache"
	"github.com/jackc/pgx/v4/pgxpool"
	"github.com/tidwall/gjson"
)

type HttpProvider struct {
	client  *http.Client
	pool    *pgxpool.Pool
	secrets map[string]string
}

func NewHttpProvider(pool *pgxpool.Pool) (Provider, error) {
	return &HttpProvider{client: http.DefaultClient, pool: pool, secrets: map[string]string{}}, nil
}

func (p *HttpProvider) GetUserFromPaymentEvent(event *PaymentEvent) (*User, error) {
	return GenericGetUser(p.pool, event)
}

func (p *HttpProvider) Auth(user *User, key string) error {
	query := `SELECT key, details->>'value' FROM credentials WHERE entity='secrets' AND userid=$1`

	rows, err := p.pool.Query(context.Background(), query, user.Id)
	if err != nil {
		return err
	}

	defer rows.Close()

	for rows.Next() {
		var a string
		var b string
		err := rows.Scan(&a, &b)

		if err != nil {
			return err
		}
		p.secrets[a] = b
	}

	if rows.Err() != nil {
		return err
	}

	return nil
}

type HttpPaymentDetails struct {
	ID           string            `json:"id"`
	Method       string            `json:"method"`
	Url          string            `json:"url"`
	Body         *json.RawMessage  `json:"body"`
	Headers      map[string]string `json:"headers"`
	ErrorMessage string            `json:"errorMessage"`
	ResponsePath string            `json:"responsePath"`
}

func (p *HttpProvider) Interpolate(s string) (string, error) {
	tmpl := mustache.New(mustache.SilentMiss(false), mustache.Delimiters("<<", ">>"))
	tmpl.ParseString(s)
	res, err := tmpl.RenderString(p.secrets)
	return res, err
}

func formatError(result *Result, event *PaymentEvent, message, code string) (*Result, error) {
	result.Success = false

	error := &PaymentError{
		Message:        message,
		Code:           code,
		PaymentDetails: event.Details,
	}

	result.Error = error
	return result, nil
}

func GetFromJson(json []byte, path string, raw bool) string {
	if path == "" {
		return string(json)
	}
	rr := gjson.GetBytes(json, path)

	if raw {
		return rr.Raw
	}
	return rr.String()
}

func (p *HttpProvider) Payout(event *PaymentEvent) (*Result, error) {
	order := new(HttpPaymentDetails)

	err := json.Unmarshal(*event.Details, &order)
	if err != nil {
		return nil, err
	}

	result := &Result{}
	result.Type = "payment:http"
	result.ID = order.ID

	url, err := p.Interpolate(order.Url)
	if err != nil {
		return formatError(result, event, err.Error(), "MISSING_SECRET")
	}

	headers := map[string]string{
		"Accept": "application/json",
	}

	for key := range order.Headers {
		val, err := p.Interpolate(order.Headers[key])
		if err != nil {
			return formatError(result, event, err.Error(), "MISSING_SECRET")
		}
		headers[key] = val
	}

	body := ""
	if order.Body != nil {
		body, err = p.Interpolate(string(*order.Body))
		if err != nil {
			return formatError(result, event, err.Error(), "MISSING_SECRET")
		}
	}

	b := strings.NewReader(body)

	ctx, _ := context.WithTimeout(context.Background(), 60*time.Second)
	req, err := http.NewRequestWithContext(ctx, order.Method, url, b)
	if err != nil {
		return formatError(result, event, err.Error(), "BAD_HTTP_REQUEST")
	}

	for header := range headers {
		req.Header.Add(header, headers[header])
	}

	dump, _ := httputil.DumpRequestOut(req, true)
	// Useful debugging for http provider
	log.Println(string(dump))

	resp, err := p.client.Do(req)
	if err != nil {
		// Fail if any http request fails
		// TODO: redo if transient and return error instead
		return formatError(result, event, err.Error(), "HTTP_REQUEST_FAILED")
	}

	success := resp.StatusCode >= 200 && resp.StatusCode <= 299

	defer resp.Body.Close()
	bodyBytes, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err // transient???
	}

	responseString := GetFromJson(bodyBytes, order.ResponsePath, true)

	// response must be valid json, can't be empty string
	if responseString == "" {
		responseString = `""`
	}

	if success {

		// convert response into json
		response := json.RawMessage([]byte(responseString))
		result.Response = &response
		result.Success = true
		result.PaymentDetails = event.Details
		return result, nil
	}

	errorMessage := GetFromJson(bodyBytes, order.ErrorMessage, false)

	code := fmt.Sprintf("%d", resp.StatusCode)
	return formatError(result, event, errorMessage, code)
}
