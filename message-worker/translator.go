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
	// Some field types arrive as platform-agnostic "text" but render on Messenger
	// as template attachments (webview button, one-time-notification request,
	// recurring notification opt-in). Dispatch on the field type carried in
	// metadata. Everything else (short_text, email, phone_number, ...) is plain
	// text — matching translate-typeform, which renders those with no quick reply.
	if len(msg.Metadata) > 0 {
		switch msg.GetTypeFromMetadata() {
		case "webview":
			return translateMessengerWebview(msg, metadata)
		case "notify":
			return translateMessengerNotify(msg, metadata)
		case "notification_messages":
			return translateMessengerNotificationMessages(msg, metadata)
		}
	}

	return types.MessengerMessage{
		Text:     *msg.Text,
		Metadata: metadata,
	}, nil
}

func metadataMap(metadata json.RawMessage) map[string]interface{} {
	m := map[string]interface{}{}
	if len(metadata) > 0 {
		_ = json.Unmarshal(metadata, &m)
	}
	return m
}

func metadataString(m map[string]interface{}, key string) string {
	if v, ok := m[key].(string); ok {
		return v
	}
	return ""
}

// translateMessengerWebview renders a webview/link field as a button template
// with a single web_url button (matches translate-typeform translateWebview).
func translateMessengerWebview(msg types.MessageContent, metadata string) (types.MessengerMessage, error) {
	md := metadataMap(msg.Metadata)
	buttonText := metadataString(md, "buttonText")
	if buttonText == "" {
		buttonText = "View website"
	}
	// messenger_extensions defaults to true when unspecified.
	extensions := true
	if e, ok := md["extensions"].(bool); ok {
		extensions = e
	}

	return types.MessengerMessage{
		Attachment: &types.Attachment{
			Type: "template",
			Payload: types.TemplatePayload{
				TemplateType: "button",
				Text:         *msg.Text,
				Buttons: []types.Button{{
					Type:                "web_url",
					URL:                 metadataString(md, "url"),
					Title:               buttonText,
					WebviewHeightRatio:  "full",
					MessengerExtensions: ptrBool(extensions),
				}},
			},
		},
		Metadata: metadata,
	}, nil
}

// translateMessengerNotify renders a notify field as a one_time_notif_req
// template (matches translate-typeform translateNotify).
func translateMessengerNotify(msg types.MessageContent, metadata string) (types.MessengerMessage, error) {
	ref := getRefFromMetadata(msg.Metadata)
	payload, err := json.Marshal(map[string]string{"ref": ref})
	if err != nil {
		return types.MessengerMessage{}, err
	}

	return types.MessengerMessage{
		Attachment: &types.Attachment{
			Type: "template",
			Payload: types.TemplatePayload{
				TemplateType: "one_time_notif_req",
				Title:        *msg.Text,
				Payload:      string(payload),
			},
		},
		Metadata: metadata,
	}, nil
}

// translateMessengerNotificationMessages renders a notification_messages field
// as a notification_messages template (matches translate-typeform).
func translateMessengerNotificationMessages(msg types.MessageContent, metadata string) (types.MessengerMessage, error) {
	md := metadataMap(msg.Metadata)
	ref := getRefFromMetadata(msg.Metadata)
	payload, err := json.Marshal(map[string]string{"ref": ref})
	if err != nil {
		return types.MessengerMessage{}, err
	}

	timezone := metadataString(md, "timezone")
	if timezone == "" {
		timezone = "UTC"
	}
	ctaText := metadataString(md, "ctaText")
	if ctaText == "" {
		ctaText = "ALLOW"
	}

	return types.MessengerMessage{
		Attachment: &types.Attachment{
			Type: "template",
			Payload: types.TemplatePayload{
				TemplateType:                 "notification_messages",
				Title:                        *msg.Text,
				NotificationMessagesTimezone: timezone,
				NotificationMessagesCTAText:  ctaText,
				Payload:                      string(payload),
			},
		},
		Metadata: metadata,
	}, nil
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

func ptrBool(b bool) *bool {
	return &b
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
				URL:        *msg.MediaURL,
				IsReusable: ptrBool(true),
			},
		},
		Metadata: metadata,
	}, nil
}
