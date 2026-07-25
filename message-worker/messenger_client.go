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

type MessengerClient struct {
	baseURL    string
	tokenStore TokenStore
	httpClient *http.Client
}

func NewMessengerClient(baseURL string, tokenStore TokenStore) *MessengerClient {
	return &MessengerClient{
		baseURL:    baseURL,
		tokenStore: tokenStore,
		httpClient: &http.Client{Timeout: 30 * time.Second},
	}
}

type FacebookSendRequest struct {
	Recipient FacebookRecipient `json:"recipient"`
	// MessagingType and Tag surface a field's message tag (sendParams) or
	// the hardcoded UTILITY class for utility_message templates. They ride
	// at the top level of the Send API request, alongside "message" — see
	// types.MessengerSendRequest, which is how the translator/worker hand
	// these off to SendMessage without baking them into the message body.
	MessagingType string      `json:"messaging_type,omitempty"`
	Tag           string      `json:"tag,omitempty"`
	Message       interface{} `json:"message"`
}

type FacebookRecipient struct {
	ID                string `json:"id,omitempty"`
	OneTimeNotifToken string `json:"one_time_notif_token,omitempty"`
}

type FacebookSendResponse struct {
	RecipientID string         `json:"recipient_id,omitempty"`
	MessageID   string         `json:"message_id,omitempty"`
	Error       *FacebookError `json:"error,omitempty"`
}

type FacebookError struct {
	Message      string `json:"message"`
	Type         string `json:"type"`
	Code         int    `json:"code"`
	ErrorSubcode int    `json:"error_subcode,omitempty"`
	FBTraceID    string `json:"fbtrace_id,omitempty"`
}

func (c *MessengerClient) SendMessage(ctx context.Context, platformAccountID, userID string, message interface{}, platformContext json.RawMessage) (*SendMessageResponse, error) {
	fmt.Printf("[MESSENGER-CLIENT] SendMessage called for user %s, platform_account %s\n", userID, platformAccountID)

	token, err := c.tokenStore.GetToken(ctx, string(types.PlatformMessenger), platformAccountID)
	if err != nil {
		fmt.Printf("[MESSENGER-CLIENT] Failed to get token: %v\n", err)
		return nil, &PlatformError{
			StatusCode: 0,
			Message:    fmt.Sprintf("failed to get token: %v", err),
			Retriable:  false,
		}
	}
	fmt.Printf("[MESSENGER-CLIENT] Got token for platform_account %s\n", platformAccountID)

	recipient := c.buildRecipient(userID, platformContext)

	req := FacebookSendRequest{Recipient: recipient}
	switch m := message.(type) {
	case types.MessengerSendRequest:
		req.Message = m.Message
		req.MessagingType = m.MessagingType
		req.Tag = m.Tag
	default:
		req.Message = message
	}

	data, err := json.Marshal(req)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal request: %w", err)
	}
	dataStr := string(data)
	if len(dataStr) > 200 {
		dataStr = dataStr[:200] + "..."
	}
	fmt.Printf("[MESSENGER-CLIENT] Marshaled request: %s\n", dataStr)

	url := c.baseURL + "/me/messages"
	fmt.Printf("[MESSENGER-CLIENT] POSTing to URL: %s\n", url)
	httpReq, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(data))
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Authorization", "Bearer "+token)

	fmt.Printf("[MESSENGER-CLIENT] Executing HTTP POST request...\n")
	resp, err := c.httpClient.Do(httpReq)
	if err != nil {
		fmt.Printf("[MESSENGER-CLIENT] HTTP request failed: %v\n", err)
		return nil, &PlatformError{
			StatusCode: 0,
			Message:    fmt.Sprintf("HTTP request failed: %v", err),
			Retriable:  true,
		}
	}
	defer resp.Body.Close()
	fmt.Printf("[MESSENGER-CLIENT] Got HTTP response, status code: %d\n", resp.StatusCode)

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read response body: %w", err)
	}
	fmt.Printf("[MESSENGER-CLIENT] Response body: %s\n", string(body))

	if resp.StatusCode >= 400 {
		fmt.Printf("[MESSENGER-CLIENT] HTTP error status %d\n", resp.StatusCode)
		return nil, c.parseHTTPError(resp.StatusCode, body)
	}

	var fbResp FacebookSendResponse
	if err := json.Unmarshal(body, &fbResp); err != nil {
		return nil, fmt.Errorf("failed to unmarshal response: %w", err)
	}

	if fbResp.Error != nil {
		fmt.Printf("[MESSENGER-CLIENT] Facebook API error: %+v\n", fbResp.Error)
		return nil, c.parseFacebookError(fbResp.Error)
	}

	fmt.Printf("[MESSENGER-CLIENT] Success! MessageID: %s\n", fbResp.MessageID)
	return &SendMessageResponse{
		MessageID: fbResp.MessageID,
		Success:   true,
	}, nil
}

func (c *MessengerClient) buildRecipient(userID string, platformContext json.RawMessage) FacebookRecipient {
	if len(platformContext) > 0 {
		var pc struct {
			OneTimeNotifToken string `json:"one_time_notif_token"`
		}
		if err := json.Unmarshal(platformContext, &pc); err == nil && pc.OneTimeNotifToken != "" {
			return FacebookRecipient{OneTimeNotifToken: pc.OneTimeNotifToken}
		}
	}
	return FacebookRecipient{ID: userID}
}

func (c *MessengerClient) parseHTTPError(statusCode int, body []byte) *PlatformError {
	var fbResp FacebookSendResponse
	if err := json.Unmarshal(body, &fbResp); err == nil && fbResp.Error != nil {
		return c.parseFacebookError(fbResp.Error)
	}
	return &PlatformError{
		StatusCode: statusCode,
		Message:    string(body),
		Retriable:  isRetriableHTTPStatus(statusCode),
	}
}

func (c *MessengerClient) parseFacebookError(fbErr *FacebookError) *PlatformError {
	return &PlatformError{
		StatusCode: fbErr.Code,
		Message:    fbErr.Message,
		Retriable:  isRetriableFacebookError(fbErr.Code),
	}
}

func isRetriableHTTPStatus(statusCode int) bool {
	switch statusCode {
	case 408, 429:
		return true
	case 500, 502, 503, 504:
		return true
	default:
		return false
	}
}

func isRetriableFacebookError(code int) bool {
	switch code {
	case 1200:
		return true
	case 551:
		return true
	default:
		return false
	}
}

func (c *MessengerClient) PassThreadControl(ctx context.Context, userID, platformAccountID, targetAppID, metadata string) error {
	fmt.Printf("[MESSENGER-CLIENT] PassThreadControl called for user %s, target_app_id %s\n", userID, targetAppID)

	token, err := c.tokenStore.GetToken(ctx, string(types.PlatformMessenger), platformAccountID)
	if err != nil {
		fmt.Printf("[MESSENGER-CLIENT] Failed to get token: %v\n", err)
		return &PlatformError{
			StatusCode: 0,
			Message:    fmt.Sprintf("failed to get token: %v", err),
			Retriable:  false,
		}
	}
	fmt.Printf("[MESSENGER-CLIENT] Got token for platform_account %s\n", platformAccountID)

	body := map[string]interface{}{
		"recipient": map[string]string{
			"id": userID,
		},
		"target_app_id": targetAppID,
		"metadata":      metadata,
	}
	bodyBytes, _ := json.Marshal(body)

	url := c.baseURL + "/me/pass_thread_control"
	fmt.Printf("[MESSENGER-CLIENT] POSTing to URL: %s\n", url)
	httpReq, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(bodyBytes))
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}

	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Authorization", "Bearer "+token)

	fmt.Printf("[MESSENGER-CLIENT] Executing HTTP POST request for pass_thread_control...\n")
	resp, err := c.httpClient.Do(httpReq)
	if err != nil {
		fmt.Printf("[MESSENGER-CLIENT] HTTP request failed: %v\n", err)
		return &PlatformError{
			StatusCode: 0,
			Message:    fmt.Sprintf("HTTP request failed: %v", err),
			Retriable:  true,
		}
	}
	defer resp.Body.Close()
	fmt.Printf("[MESSENGER-CLIENT] Got HTTP response, status code: %d\n", resp.StatusCode)

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("failed to read response body: %w", err)
	}
	fmt.Printf("[MESSENGER-CLIENT] Response body: %s\n", string(respBody))

	if resp.StatusCode >= 400 {
		fmt.Printf("[MESSENGER-CLIENT] HTTP error status %d\n", resp.StatusCode)
		return c.parseHTTPError(resp.StatusCode, respBody)
	}

	var fbResp FacebookSendResponse
	if err := json.Unmarshal(respBody, &fbResp); err != nil {
		return fmt.Errorf("failed to unmarshal response: %w", err)
	}

	if fbResp.Error != nil {
		fmt.Printf("[MESSENGER-CLIENT] Facebook API error: %+v\n", fbResp.Error)
		return c.parseFacebookError(fbResp.Error)
	}

	fmt.Printf("[MESSENGER-CLIENT] PassThreadControl succeeded\n")
	return nil
}
