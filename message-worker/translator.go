package messageworker

import (
	"encoding/json"
	"fmt"

	"github.com/vlab-research/fly/message-worker/types"
)

func TranslateToMessenger(cmd types.SendMessageCommand) (types.MessengerMessage, error) {
	if err := cmd.Message.Validate(); err != nil {
		return types.MessengerMessage{}, err
	}

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

func getMetadataString(metadata json.RawMessage) string {
	if len(metadata) == 0 {
		return ""
	}
	return string(metadata)
}

func getRefFromMetadata(metadata json.RawMessage) string {
	if len(metadata) == 0 {
		return ""
	}
	var m map[string]interface{}
	if err := json.Unmarshal(metadata, &m); err != nil {
		return ""
	}
	if ref, ok := m["ref"]; ok {
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

	if len(msg.Metadata) > 0 {
		fieldType := msg.GetTypeFromMetadata()
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

	return result, nil
}

func translateMessengerQuestion(msg types.MessageContent, metadata string) (types.MessengerMessage, error) {
	const maxQuickReplies = 13

	if len(msg.Options) > maxQuickReplies {
		return types.MessengerMessage{}, fmt.Errorf("%w: Messenger supports max %d quick replies, got %d",
			types.ErrTooManyOptions, maxQuickReplies, len(msg.Options))
	}

	ref := getRefFromMetadata(msg.Metadata)

	quickReplies := make([]types.QuickReply, len(msg.Options))
	for i, opt := range msg.Options {
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

func buildQuickReplyPayload(value json.RawMessage, ref string) string {
	if ref == "" {
		var s string
		if err := json.Unmarshal(value, &s); err == nil {
			return s
		}
		return string(value)
	}

	payload := map[string]json.RawMessage{
		"value": value,
		"ref":   json.RawMessage(`"` + ref + `"`),
	}
	data, err := json.Marshal(payload)
	if err != nil {
		return ""
	}
	return string(data)
}

func translateMessengerMedia(msg types.MessageContent, metadata string) (types.MessengerMessage, error) {
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
