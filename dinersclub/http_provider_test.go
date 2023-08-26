package main

import (
	"encoding/json"
	"fmt"
	"io"
	"testing"

	"net/http"
	"net/http/httptest"

	"github.com/stretchr/testify/assert"
)

func TestIntepolate_GetsFromSecrets(t *testing.T) {

	p := &HttpProvider{
		secrets: map[string]string{
			"foo": "bar",
		},
	}
	s, err := p.Interpolate("<< foo >> baz")
	assert.Nil(t, err)
	assert.Equal(t, "bar baz", s)
}

func TestIntepolate_ErrorsIfValueMissing(t *testing.T) {

	p := &HttpProvider{
		secrets: map[string]string{
			"foo": "bar",
		},
	}

	_, err := p.Interpolate("<< fooz >> baz")
	assert.NotNil(t, err)
	assert.Contains(t, err.Error(), "fooz")
}

func TestHttpProviderAuth_GetsSecrets(t *testing.T) {
	cfg := getConfig()
	pool := getPool(cfg)
	defer pool.Close()
	before(t, pool)

	insertUserSql := `
		INSERT INTO users(id, email)
		VALUES ('00000000-0000-0000-0000-000000000000', 'test@test.com');
	`
	mustExec(t, pool, insertUserSql)

	insertSecretSql := `
		INSERT INTO credentials(userid, entity, key, details)
		VALUES ('00000000-0000-0000-0000-000000000000', 'secrets', 'foo', '{"value": "bar"}'), ('00000000-0000-0000-0000-000000000000', 'secrets', 'baz', '{"value": "qux"}');  ;
	`
	mustExec(t, pool, insertSecretSql)

	p := &HttpProvider{
		client:  http.DefaultClient,
		pool:    pool,
		secrets: map[string]string{},
	}

	user := &User{Id: "00000000-0000-0000-0000-000000000000"}
	p.Auth(user, "anythingcanbehere")
	assert.Equal(t, 2, len(p.secrets))
	assert.Equal(t, "bar", p.secrets["foo"])
	assert.Equal(t, "qux", p.secrets["baz"])
}

func TestHttpProviderPayout_MakesPostRequestsWithInterpolatedSecrets(t *testing.T) {
	response := `{"bar": "baz"}`

	reqBody := `{"amount": 100, "phone_number": "+7777777"}`

	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "Bearer sosecret", r.Header.Get("Authorization"))
		assert.Equal(t, "43", r.Header.Get("Content-Length"))
		assert.Equal(t, "application/json", r.Header.Get("Accept"))

		assert.Equal(t, "POST", r.Method)

		assert.Equal(t, "/foo", r.URL.Path)
		assert.Equal(t, "auth=ohsosecret", r.URL.RawQuery)

		b, _ := io.ReadAll(r.Body)
		assert.Equal(t, reqBody, string(b))

		w.WriteHeader(200)
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, response)
	}))

	p := &HttpProvider{
		client:  http.DefaultClient,
		pool:    nil,
		secrets: map[string]string{"foo": "sosecret", "bar": "ohsosecret"},
	}

	details := json.RawMessage([]byte(
		fmt.Sprintf(`{
                  "method": "POST",
                  "url": "%s/foo?auth=<< bar >>",
                  "headers": {"Authorization": "Bearer << foo >>"},
                  "body": %s }`, ts.URL, reqBody),
	))

	event := &PaymentEvent{Details: &details}

	res, err := p.Payout(event)

	assert.Nil(t, err)
	assert.Equal(t, true, res.Success)
	// adds details from api as payment details
	assert.Equal(t, json.RawMessage([]byte(response)), *res.Response)
}

func TestHttpProviderPayout_MakesGetRequestsWithoutBodyOrHeaders(t *testing.T) {
	response := `{"bar": "baz"}`

	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "GET", r.Method)

		assert.Equal(t, "/foo", r.URL.Path)
		assert.Equal(t, "auth=ohsosecret", r.URL.RawQuery)
		b, _ := io.ReadAll(r.Body)
		assert.Equal(t, "", string(b))

		w.WriteHeader(200)
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, response)
	}))

	p := &HttpProvider{
		client:  http.DefaultClient,
		pool:    nil,
		secrets: map[string]string{"bar": "ohsosecret"},
	}

	details := json.RawMessage([]byte(
		fmt.Sprintf(`{
                  "method": "GET",
                  "url": "%s/foo?auth=<< bar >>"}`, ts.URL),
	))

	event := &PaymentEvent{Details: &details}

	res, err := p.Payout(event)

	assert.Nil(t, err)
	assert.Equal(t, true, res.Success)

}

func TestHttpProviderPayout_RetrievesErrorMessage(t *testing.T) {
	response := `{"foo": {"bar": "hello error"}, "baz": "hello error"}`
	tc := TestClient(400, response, nil)

	p := &HttpProvider{
		client: tc,
		secrets: map[string]string{
			"foo": "bar",
		},
	}

	// get nested message
	details := json.RawMessage([]byte(
		`{
                  "method": "POST",
                  "url": "https://foo.com",
		  "errorMessage": "foo.bar"}`,
	))
	event := &PaymentEvent{Details: &details}

	res, err := p.Payout(event)

	assert.Nil(t, err)
	assert.Equal(t, false, res.Success)
	assert.Equal(t, "400", res.Error.Code)
	assert.Equal(t, "hello error", res.Error.Message)

	// response is nil when there is an error
	assert.Nil(t, res.Response)

	// get directly from root of json
	details = json.RawMessage([]byte(
		`{
                  "method": "POST",
                  "url": "https://foo.com",
		  "errorMessage": "baz"}`,
	))
	event = &PaymentEvent{Details: &details}

	res, err = p.Payout(event)
	assert.Nil(t, err)
	assert.Equal(t, false, res.Success)
	assert.Equal(t, "400", res.Error.Code)
	assert.Equal(t, "hello error", res.Error.Message)

	// response is nil when there is an error
	assert.Nil(t, res.Response)
}

func TestHttpProviderPayout_ErrorsWithNoMessageOnFailingToRetrieveErrorMessage(t *testing.T) {
	response := `text response to error, not json`

	tc := TestClient(400, response, nil)

	p := &HttpProvider{
		client: tc,
	}

	// get nested message
	details := json.RawMessage([]byte(
		`{
                  "method": "POST",
                  "url": "https://foo.com",
                  "responsePath": "foo.bar",
		  "errorMessage": "not.a.path"}`,
	))

	event := &PaymentEvent{Details: &details}

	res, err := p.Payout(event)

	assert.Nil(t, err)
	assert.Equal(t, false, res.Success)
	assert.Equal(t, "400", res.Error.Code)
	assert.Equal(t, "", res.Error.Message)

	// response is nil when there is an error
	assert.Nil(t, res.Response)

	// can marshal response
	_, err = json.Marshal(res)
	assert.Nil(t, err)
}

func TestHttpProviderPayout_RetrievesStringResponseFromPath(t *testing.T) {
	response := `{"foo": {"bar": [{"baz": "hello response"}]}}`
	tc := TestClient(200, response, nil)

	p := &HttpProvider{
		client: tc,
	}

	// get nested message
	details := json.RawMessage([]byte(
		`{
                  "method": "POST",
                  "url": "https://foo.com",
		  "responsePath": "foo.bar.0.baz"}`,
	))
	event := &PaymentEvent{Details: &details}

	res, err := p.Payout(event)

	assert.Nil(t, err)
	assert.Equal(t, true, res.Success)
	assert.Equal(t, `"hello response"`, string(*res.Response))

	// can marshal response
	_, err = json.Marshal(res)
	assert.Nil(t, err)
}

func TestHttpProviderPayout_RetrievesJsonResponseFromPath(t *testing.T) {
	response := `{"foo": {"bar": [{"baz": "hello response"}]}}`
	tc := TestClient(200, response, nil)

	p := &HttpProvider{
		client: tc,
	}

	// get nested message
	details := json.RawMessage([]byte(
		`{
                  "method": "POST",
                  "url": "https://foo.com",
		  "responsePath": "foo.bar"}`,
	))
	event := &PaymentEvent{Details: &details}

	res, err := p.Payout(event)

	assert.Nil(t, err)
	assert.Equal(t, true, res.Success)
	assert.Equal(t, `[{"baz": "hello response"}]`, string(*res.Response))

	// can marshal response
	_, err = json.Marshal(res)
	assert.Nil(t, err)
}

func TestHttpProviderPayout_DoesNotErrorIfResponseDoesNotExist(t *testing.T) {
	response := `{"foo": {"bar": [{"baz": "hello response"}]}}`
	tc := TestClient(200, response, nil)

	p := &HttpProvider{
		client: tc,
	}

	// get nested message
	details := json.RawMessage([]byte(
		`{
                  "method": "POST",
                  "url": "https://foo.com",
		  "responsePath": "not.a.path"}`,
	))
	event := &PaymentEvent{Details: &details}

	res, err := p.Payout(event)

	assert.Nil(t, err)
	assert.Equal(t, true, res.Success)
	assert.Equal(t, `""`, string(*res.Response))

	// can marshal response
	_, err = json.Marshal(res)
	assert.Nil(t, err)
}

func TestHttpProviderPayout_DoesNotErrorIfResponseIsNotJson(t *testing.T) {
	response := `Pure text response`
	tc := TestClient(200, response, nil)

	p := &HttpProvider{
		client: tc,
	}

	// get nested message
	details := json.RawMessage([]byte(
		`{
                  "method": "POST",
                  "url": "https://foo.com",
		  "responsePath": "not.a.path"}`,
	))
	event := &PaymentEvent{Details: &details}

	res, err := p.Payout(event)

	assert.Nil(t, err)
	assert.Equal(t, true, res.Success)
	assert.Equal(t, `""`, string(*res.Response))

	// can marshal response
	_, err = json.Marshal(res)
	assert.Nil(t, err)
}

func TestHttpProviderPayout_GeneratesErrorForUserIfMissingSecrets(t *testing.T) {
	tc := TestClient(200, `{"foo": {"bar": "hello error"}`, nil)

	p := &HttpProvider{
		client: tc,
		secrets: map[string]string{
			"foo": "bar",
		},
	}

	details := json.RawMessage([]byte(
		`{
                  "method": "POST",
                  "url": "https://foo.com",
                  "headers": {"Authorization": "Bearer << notfoo >>"},
                  "body": {"foo": "bar"},
		  "errorMessage": "foo.bar"}`,
	))

	event := &PaymentEvent{Details: &details}

	res, err := p.Payout(event)

	assert.Nil(t, err)
	assert.Equal(t, false, res.Success)
	assert.Equal(t, "MISSING_SECRET", res.Error.Code)
	assert.Equal(t, "failed to lookup notfoo", res.Error.Message)
}

func TestHttpProviderPayout_GeneratesErrorForUserBadRequest(t *testing.T) {
	tc := TestClient(200, `{"foo": {"bar": "hello error"}`, nil)

	p := &HttpProvider{
		client: tc,
	}

	details := json.RawMessage([]byte(
		`{
                  "method": "POST",
                  "url": "https://foo  .com",
                  "headers": {},
                  "body": {"foo": "bar"},
		  "errorMessage": "foo.bar"}`,
	))

	event := &PaymentEvent{Details: &details}

	res, err := p.Payout(event)

	assert.Nil(t, err)
	assert.Equal(t, false, res.Success)
	assert.Equal(t, "BAD_HTTP_REQUEST", res.Error.Code)
}
