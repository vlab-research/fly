package messageworker

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// MessengerClient sends messages via the Facebook Graph API
type MessengerClient struct {
	baseURL    string      // e.g., "https://graph.facebook.com/v18.0" or "http://gbv-facebot"
	tokenStore TokenStore
	httpClient *http.Client
}

// NewMessengerClient creates a new MessengerClient
func NewMessengerClient(baseURL string, tokenStore TokenStore) *MessengerClient {
	return &MessengerClient{
		baseURL:    baseURL,
		tokenStore: tokenStore,
		httpClient: &http.Client{Timeout: 30 * time.Second},
	}
}

// FacebookSendRequest represents the Facebook Graph API send message request format
type FacebookSendRequest struct {
	Recipient FacebookRecipient `json:"recipient"`
	Message   interface{}       `json:"message"`
}

// FacebookRecipient represents the recipient in Facebook Graph API format
type FacebookRecipient struct {
	ID string `json:"id"`
}

// FacebookSendResponse represents the Facebook Graph API send message response
type FacebookSendResponse struct {
	RecipientID string          `json:"recipient_id,omitempty"`
	MessageID   string          `json:"message_id,omitempty"`
	Error       *FacebookError  `json:"error,omitempty"`
}

// FacebookError represents a Facebook API error
type FacebookError struct {
	Message   string `json:"message"`
	Type      string `json:"type"`
	Code      int    `json:"code"`
	ErrorSubcode int `json:"error_subcode,omitempty"`
	FBTraceID string `json:"fbtrace_id,omitempty"`
}

// SendMessage sends a message via the Facebook Graph API
// The message should be a types.MessengerMessage (already translated by translator.go)
func (c *MessengerClient) SendMessage(ctx context.Context, platformAccountID, userID string, message interface{}) (*SendMessageResponse, error) {
	fmt.Printf("[MESSENGER-CLIENT] SendMessage called for user %s, platform_account %s\n", userID, platformAccountID)

	// Get access token for this platform account (page)
	token, err := c.tokenStore.GetToken(ctx, platformAccountID)
	if err != nil {
		fmt.Printf("[MESSENGER-CLIENT] Failed to get token: %v\n", err)
		return nil, &PlatformError{
			StatusCode: 0,
			Message:    fmt.Sprintf("failed to get token: %v", err),
			Retriable:  false, // Token errors are not retriable
		}
	}
	fmt.Printf("[MESSENGER-CLIENT] Got token for platform_account %s\n", platformAccountID)

	// Build Facebook Graph API request format
	req := FacebookSendRequest{
		Recipient: FacebookRecipient{ID: userID},
		Message:   message,
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

	// Create HTTP request to /me/messages endpoint
	url := c.baseURL + "/me/messages"
	fmt.Printf("[MESSENGER-CLIENT] POSTing to URL: %s\n", url)
	httpReq, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(data))
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	// Set headers - Facebook uses Bearer token authentication
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Authorization", "Bearer "+token)

	// Execute request
	fmt.Printf("[MESSENGER-CLIENT] Executing HTTP POST request...\n")
	resp, err := c.httpClient.Do(httpReq)
	if err != nil {
		fmt.Printf("[MESSENGER-CLIENT] HTTP request failed: %v\n", err)
		return nil, &PlatformError{
			StatusCode: 0,
			Message:    fmt.Sprintf("HTTP request failed: %v", err),
			Retriable:  true, // Network errors are retriable
		}
	}
	defer resp.Body.Close()
	fmt.Printf("[MESSENGER-CLIENT] Got HTTP response, status code: %d\n", resp.StatusCode)

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read response body: %w", err)
	}
	fmt.Printf("[MESSENGER-CLIENT] Response body: %s\n", string(body))

	// Check for HTTP errors
	if resp.StatusCode >= 400 {
		fmt.Printf("[MESSENGER-CLIENT] HTTP error status %d\n", resp.StatusCode)
		return nil, c.parseHTTPError(resp.StatusCode, body)
	}

	// Parse Facebook response
	var fbResp FacebookSendResponse
	if err := json.Unmarshal(body, &fbResp); err != nil {
		return nil, fmt.Errorf("failed to unmarshal response: %w", err)
	}

	// Check for Facebook API error in response body
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

// parseHTTPError creates a PlatformError from HTTP status code
func (c *MessengerClient) parseHTTPError(statusCode int, body []byte) *PlatformError {
	// Try to parse Facebook error from body
	var fbResp FacebookSendResponse
	if err := json.Unmarshal(body, &fbResp); err == nil && fbResp.Error != nil {
		return c.parseFacebookError(fbResp.Error)
	}

	// Fall back to generic HTTP error
	return &PlatformError{
		StatusCode: statusCode,
		Message:    string(body),
		Retriable:  isRetriableHTTPStatus(statusCode),
	}
}

// parseFacebookError creates a PlatformError from Facebook API error
func (c *MessengerClient) parseFacebookError(fbErr *FacebookError) *PlatformError {
	return &PlatformError{
		StatusCode: fbErr.Code,
		Message:    fbErr.Message,
		Retriable:  isRetriableFacebookError(fbErr.Code),
	}
}

// isRetriableHTTPStatus checks if HTTP status code indicates retriable error
func isRetriableHTTPStatus(statusCode int) bool {
	switch statusCode {
	case 408, 429: // Request Timeout, Too Many Requests
		return true
	case 500, 502, 503, 504: // Server errors
		return true
	default:
		return false
	}
}

// isRetriableFacebookError checks if Facebook error code indicates retriable error
// Based on Facebook documentation and old replybot behavior
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

// SendNativeMessage sends a pre-formatted Facebook-native message payload.
// The payload should be the complete Facebook API request body including
// "recipient" and "message" fields. This bypasses translation and sends
// the payload directly to /me/messages.
func (c *MessengerClient) SendNativeMessage(ctx context.Context, userID, platformAccountID string, payload json.RawMessage) (string, error) {
	fmt.Printf("[MESSENGER-CLIENT] SendNativeMessage called for user %s, platform_account %s\n", userID, platformAccountID)

	// Get access token for this platform account (page)
	token, err := c.tokenStore.GetToken(ctx, platformAccountID)
	if err != nil {
		fmt.Printf("[MESSENGER-CLIENT] Failed to get token: %v\n", err)
		return "", &PlatformError{
			StatusCode: 0,
			Message:    fmt.Sprintf("failed to get token: %v", err),
			Retriable:  false, // Token errors are not retriable
		}
	}
	fmt.Printf("[MESSENGER-CLIENT] Got token for platform_account %s\n", platformAccountID)

	// Create HTTP request to /me/messages endpoint
	url := c.baseURL + "/me/messages"
	fmt.Printf("[MESSENGER-CLIENT] POSTing native payload to URL: %s\n", url)
	httpReq, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(payload))
	if err != nil {
		return "", fmt.Errorf("failed to create request: %w", err)
	}

	// Set headers - Facebook uses Bearer token authentication
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Authorization", "Bearer "+token)

	// Execute request
	fmt.Printf("[MESSENGER-CLIENT] Executing HTTP POST request for native message...\n")
	resp, err := c.httpClient.Do(httpReq)
	if err != nil {
		fmt.Printf("[MESSENGER-CLIENT] HTTP request failed: %v\n", err)
		return "", &PlatformError{
			StatusCode: 0,
			Message:    fmt.Sprintf("HTTP request failed: %v", err),
			Retriable:  true, // Network errors are retriable
		}
	}
	defer resp.Body.Close()
	fmt.Printf("[MESSENGER-CLIENT] Got HTTP response, status code: %d\n", resp.StatusCode)

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", fmt.Errorf("failed to read response body: %w", err)
	}
	fmt.Printf("[MESSENGER-CLIENT] Response body: %s\n", string(body))

	// Check for HTTP errors
	if resp.StatusCode >= 400 {
		fmt.Printf("[MESSENGER-CLIENT] HTTP error status %d\n", resp.StatusCode)
		return "", c.parseHTTPError(resp.StatusCode, body)
	}

	// Parse Facebook response
	var fbResp FacebookSendResponse
	if err := json.Unmarshal(body, &fbResp); err != nil {
		return "", fmt.Errorf("failed to unmarshal response: %w", err)
	}

	// Check for Facebook API error in response body
	if fbResp.Error != nil {
		fmt.Printf("[MESSENGER-CLIENT] Facebook API error: %+v\n", fbResp.Error)
		return "", c.parseFacebookError(fbResp.Error)
	}

	fmt.Printf("[MESSENGER-CLIENT] Success! MessageID: %s\n", fbResp.MessageID)
	return fbResp.MessageID, nil
}

// PassThreadControl hands off the conversation to another app.
// Calls POST /me/pass_thread_control with the target app ID and metadata.
func (c *MessengerClient) PassThreadControl(ctx context.Context, userID, platformAccountID, targetAppID, metadata string) error {
	fmt.Printf("[MESSENGER-CLIENT] PassThreadControl called for user %s, target_app_id %s\n", userID, targetAppID)

	// Get access token for this platform account (page)
	token, err := c.tokenStore.GetToken(ctx, platformAccountID)
	if err != nil {
		fmt.Printf("[MESSENGER-CLIENT] Failed to get token: %v\n", err)
		return &PlatformError{
			StatusCode: 0,
			Message:    fmt.Sprintf("failed to get token: %v", err),
			Retriable:  false, // Token errors are not retriable
		}
	}
	fmt.Printf("[MESSENGER-CLIENT] Got token for platform_account %s\n", platformAccountID)

	// Build request body for pass_thread_control endpoint
	body := map[string]interface{}{
		"recipient": map[string]string{
			"id": userID,
		},
		"target_app_id": targetAppID,
		"metadata":      metadata,
	}
	bodyBytes, _ := json.Marshal(body)

	// Create HTTP request to /me/pass_thread_control endpoint
	url := c.baseURL + "/me/pass_thread_control"
	fmt.Printf("[MESSENGER-CLIENT] POSTing to URL: %s\n", url)
	httpReq, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(bodyBytes))
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}

	// Set headers - Facebook uses Bearer token authentication
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Authorization", "Bearer "+token)

	// Execute request
	fmt.Printf("[MESSENGER-CLIENT] Executing HTTP POST request for pass_thread_control...\n")
	resp, err := c.httpClient.Do(httpReq)
	if err != nil {
		fmt.Printf("[MESSENGER-CLIENT] HTTP request failed: %v\n", err)
		return &PlatformError{
			StatusCode: 0,
			Message:    fmt.Sprintf("HTTP request failed: %v", err),
			Retriable:  true, // Network errors are retriable
		}
	}
	defer resp.Body.Close()
	fmt.Printf("[MESSENGER-CLIENT] Got HTTP response, status code: %d\n", resp.StatusCode)

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("failed to read response body: %w", err)
	}
	fmt.Printf("[MESSENGER-CLIENT] Response body: %s\n", string(respBody))

	// Check for HTTP errors
	if resp.StatusCode >= 400 {
		fmt.Printf("[MESSENGER-CLIENT] HTTP error status %d\n", resp.StatusCode)
		return c.parseHTTPError(resp.StatusCode, respBody)
	}

	// Parse Facebook response - may include success or error field
	var fbResp FacebookSendResponse
	if err := json.Unmarshal(respBody, &fbResp); err != nil {
		return fmt.Errorf("failed to unmarshal response: %w", err)
	}

	// Check for Facebook API error in response body
	if fbResp.Error != nil {
		fmt.Printf("[MESSENGER-CLIENT] Facebook API error: %+v\n", fbResp.Error)
		return c.parseFacebookError(fbResp.Error)
	}

	fmt.Printf("[MESSENGER-CLIENT] PassThreadControl succeeded\n")
	return nil
}
