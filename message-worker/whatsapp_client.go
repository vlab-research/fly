package messageworker

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/vlab-research/fly/message-worker/types"
)

// WhatsAppClient sends messages via the WhatsApp Cloud API. It mirrors
// MessengerClient: a configurable baseURL (pointed at a mock in tests), a
// TokenStore for the per-phone-number access token, and a 30s HTTP client.
type WhatsAppClient struct {
	baseURL    string
	tokenStore TokenStore
	httpClient *http.Client
}

func NewWhatsAppClient(baseURL string, tokenStore TokenStore) *WhatsAppClient {
	return &WhatsAppClient{
		baseURL:    baseURL,
		tokenStore: tokenStore,
		httpClient: &http.Client{Timeout: 30 * time.Second},
	}
}

// WhatsAppSendRequest is the Cloud API send envelope. It embeds the translated
// WhatsAppMessage (Type + type-specific body) alongside the messaging_product
// and recipient fields the API requires; embedding flattens the message fields
// (type, text, interactive, ...) to the top level of the JSON body.
type WhatsAppSendRequest struct {
	MessagingProduct string `json:"messaging_product"`
	RecipientType    string `json:"recipient_type,omitempty"`
	To               string `json:"to"`
	types.WhatsAppMessage
}

type WhatsAppSendResponse struct {
	Messages []struct {
		ID string `json:"id"`
	} `json:"messages"`
	Error *FacebookError `json:"error,omitempty"`
}

func (c *WhatsAppClient) SendMessage(ctx context.Context, platformAccountID, userID string, message interface{}, platformContext json.RawMessage) (*SendMessageResponse, error) {
	token, err := c.tokenStore.GetToken(ctx, platformAccountID)
	if err != nil {
		return nil, &PlatformError{
			StatusCode: 0,
			Message:    fmt.Sprintf("failed to get token: %v", err),
			Retriable:  false,
		}
	}

	waMsg, ok := message.(types.WhatsAppMessage)
	if !ok {
		return nil, fmt.Errorf("whatsapp client expected types.WhatsAppMessage, got %T", message)
	}

	req := WhatsAppSendRequest{
		MessagingProduct: "whatsapp",
		RecipientType:    "individual",
		To:               userID,
		WhatsAppMessage:  waMsg,
	}

	data, err := json.Marshal(req)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal request: %w", err)
	}

	// WhatsApp Cloud API: POST /{phone_number_id}/messages
	url := fmt.Sprintf("%s/%s/messages", c.baseURL, platformAccountID)
	httpReq, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(data))
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Authorization", "Bearer "+token)

	resp, err := c.httpClient.Do(httpReq)
	if err != nil {
		return nil, &PlatformError{
			StatusCode: 0,
			Message:    fmt.Sprintf("HTTP request failed: %v", err),
			Retriable:  true,
		}
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read response body: %w", err)
	}

	if resp.StatusCode >= 400 {
		return nil, c.parseHTTPError(resp.StatusCode, body)
	}

	var waResp WhatsAppSendResponse
	if err := json.Unmarshal(body, &waResp); err != nil {
		return nil, fmt.Errorf("failed to unmarshal response: %w", err)
	}
	if waResp.Error != nil {
		return nil, &PlatformError{
			StatusCode: waResp.Error.Code,
			Message:    waResp.Error.Message,
			Retriable:  isRetriableFacebookError(waResp.Error.Code),
		}
	}

	messageID := ""
	if len(waResp.Messages) > 0 {
		messageID = waResp.Messages[0].ID
	}
	return &SendMessageResponse{MessageID: messageID, Success: true}, nil
}

func (c *WhatsAppClient) parseHTTPError(statusCode int, body []byte) *PlatformError {
	var waResp WhatsAppSendResponse
	if err := json.Unmarshal(body, &waResp); err == nil && waResp.Error != nil {
		return &PlatformError{
			StatusCode: waResp.Error.Code,
			Message:    waResp.Error.Message,
			Retriable:  isRetriableFacebookError(waResp.Error.Code),
		}
	}
	return &PlatformError{
		StatusCode: statusCode,
		Message:    string(body),
		Retriable:  isRetriableHTTPStatus(statusCode),
	}
}

// PassThreadControl is a no-op for WhatsApp: the Cloud API has no thread-control
// / handoff primitive (unlike Messenger's pass_thread_control). Returning nil
// keeps a survey that hands off on WhatsApp from erroring the worker; a proper
// WhatsApp handoff mechanism is deferred.
func (c *WhatsAppClient) PassThreadControl(ctx context.Context, userID, platformAccountID, targetAppID, metadata string) error {
	return nil
}
