package messageworker

import (
	"encoding/json"
	"fmt"

	"github.com/vlab-research/fly/message-worker/types"
)

// TranslateToMessenger translates a platform-agnostic message to Messenger format
func TranslateToMessenger(cmd types.SendMessageCommand) (types.MessengerMessage, error) {
	// Validate message content
	if err := cmd.Message.Validate(); err != nil {
		return types.MessengerMessage{}, err
	}

	// Extract metadata string for Messenger (JSON encoded)
	metadata := getMetadataString(cmd.Message.Metadata)

	switch cmd.Message.Type {
	case types.MessageTypeText:
		return translateMessengerText(cmd.Message, metadata)
	case types.MessageTypeQuestion:
		return translateMessengerQuestion(cmd.Message, metadata)
	case types.MessageTypeMedia:
		return translateMessengerMedia(cmd.Message, metadata)
	default:
		return types.MessengerMessage{}, fmt.Errorf("%w: %s", types.ErrUnsupportedMessageType, cmd.Message.Type)
	}
}

// getMetadataString converts metadata map to JSON string for Messenger
func getMetadataString(metadata map[string]interface{}) string {
	if metadata == nil || len(metadata) == 0 {
		return ""
	}
	data, err := json.Marshal(metadata)
	if err != nil {
		return ""
	}
	return string(data)
}

// getRefFromMetadata extracts the ref from metadata
func getRefFromMetadata(metadata map[string]interface{}) string {
	if metadata == nil {
		return ""
	}
	if ref, ok := metadata["ref"]; ok {
		if refStr, ok := ref.(string); ok {
			return refStr
		}
	}
	return ""
}

func translateMessengerText(msg types.MessageContent, metadata string) (types.MessengerMessage, error) {
	result := types.MessengerMessage{
		Text:     *msg.Text,
		Metadata: metadata,
	}

	// Check metadata for special field types that need quick_replies
	// (phone_number, email) - these use Messenger's built-in quick reply types
	if msg.Metadata != nil {
		if fieldType, ok := msg.Metadata["type"].(string); ok {
			switch fieldType {
			case "phone_number":
				result.QuickReplies = []types.QuickReply{
					{ContentType: "user_phone_number"},
				}
			case "email":
				result.QuickReplies = []types.QuickReply{
					{ContentType: "user_email"},
				}
			}
		}
	}

	return result, nil
}

func translateMessengerQuestion(msg types.MessageContent, metadata string) (types.MessengerMessage, error) {
	// Messenger supports up to 13 quick replies
	const maxQuickReplies = 13

	if len(msg.Options) > maxQuickReplies {
		return types.MessengerMessage{}, fmt.Errorf("%w: Messenger supports max %d quick replies, got %d",
			types.ErrTooManyOptions, maxQuickReplies, len(msg.Options))
	}

	ref := getRefFromMetadata(msg.Metadata)

	quickReplies := make([]types.QuickReply, len(msg.Options))
	for i, opt := range msg.Options {
		// Embed ref and value in payload as JSON (like old replybot)
		payload := buildQuickReplyPayload(opt.Value, ref)

		quickReplies[i] = types.QuickReply{
			ContentType: "text",
			Title:       opt.Label,
			Payload:     payload,
		}
	}

	return types.MessengerMessage{
		Text:         *msg.QuestionText,
		QuickReplies: quickReplies,
		Metadata:     metadata,
	}, nil
}

// buildQuickReplyPayload creates a JSON payload with value and ref
// This matches the old replybot format: {"value":"...", "ref":"..."}
// Value can be string, boolean, or number depending on field type
func buildQuickReplyPayload(value interface{}, ref string) string {
	if ref == "" {
		// If no ref, just use the raw value (simple case)
		data, err := json.Marshal(value)
		if err != nil {
			return ""
		}
		// Return the JSON-encoded value without quotes for strings
		// to maintain backwards compatibility
		if s, ok := value.(string); ok {
			return s
		}
		return string(data)
	}

	payload := map[string]interface{}{
		"value": value,
		"ref":   ref,
	}
	data, err := json.Marshal(payload)
	if err != nil {
		return ""
	}
	return string(data)
}

func translateMessengerMedia(msg types.MessageContent, metadata string) (types.MessengerMessage, error) {
	// Map media type to Messenger attachment type
	var attachmentType string
	switch *msg.MediaType {
	case types.MediaTypeImage:
		attachmentType = "image"
	case types.MediaTypeVideo:
		attachmentType = "video"
	case types.MediaTypeAudio:
		attachmentType = "audio"
	case types.MediaTypeFile:
		attachmentType = "file"
	default:
		return types.MessengerMessage{}, fmt.Errorf("%w: %s", types.ErrUnsupportedMediaType, *msg.MediaType)
	}

	return types.MessengerMessage{
		Attachment: &types.Attachment{
			Type: attachmentType,
			Payload: types.AttachmentPayload{
				URL: *msg.MediaURL,
			},
		},
		Metadata: metadata,
	}, nil
}
