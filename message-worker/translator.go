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

	// utility_message (the go-forward re-contact mechanism) is dispatched
	// ahead of the base-type switch below: replybot emits it as base type
	// "question" when the field has choices/buttons and "text" when it
	// doesn't (generic-translator.js translateUtilityMessage) — the
	// metadata.type discriminator is what identifies it, not
	// MessageContent.Type.
	if cmd.Message.GetTypeFromMetadata() == "utility_message" {
		return translateMessengerUtility(cmd.Message, metadata)
	}

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

// getMessengerSendParams derives the top-level Facebook Send API
// messaging_type/tag that must ride alongside — not inside — the message
// body TranslateToMessenger produces (Facebook puts messaging_type/tag as
// siblings of "message" on the request). UTILITY is hardcoded for
// utility_message fields (message-worker's own concern — replybot's
// generic-translator.js doesn't set sendParams for it); message tags come
// from the field's sendParams metadata, which replybot's transition.js
// buildCommands nests at message.metadata.sendParams and never promotes to
// the top level (see transition.test.js "carries sendParams (message-tag)
// through to the outbound command...").
func getMessengerSendParams(cmd types.SendMessageCommand) (messagingType, tag string) {
	if cmd.Message.GetTypeFromMetadata() == "utility_message" {
		return "UTILITY", ""
	}

	md := metadataMap(cmd.Message.Metadata)
	sendParams, ok := md["sendParams"].(map[string]interface{})
	if !ok {
		return "", ""
	}
	messagingType, _ = sendParams["messaging_type"].(string)
	tag, _ = sendParams["tag"].(string)
	return messagingType, tag
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

// translateMessengerUtility renders a utility_message field as a Meta
// message template (matches translate-typeform's translateUtilityMessage).
// template/language/params come from the field's metadata (populated from
// its parsed YAML description); buttons come from the field's own
// choices/options — one {type: POSTBACK, payload: <field ref>} per choice,
// same ref value repeated for every button, per the reference translator.
// A body component is always present (even with zero params); a buttons
// component is only added when there are choices.
func translateMessengerUtility(msg types.MessageContent, metadata string) (types.MessengerMessage, error) {
	md := metadataMap(msg.Metadata)

	template := metadataString(md, "template")
	if template == "" {
		return types.MessengerMessage{}, fmt.Errorf("%w", types.ErrMissingUtilityTemplate)
	}
	language := metadataString(md, "language")
	if language == "" {
		return types.MessengerMessage{}, fmt.Errorf("%w", types.ErrMissingUtilityLanguage)
	}

	params := metadataStringSlice(md, "params")
	bodyParams := make([]types.TemplateComponentParameter, len(params))
	for i, p := range params {
		bodyParams[i] = types.TemplateComponentParameter{Type: "text", Text: p}
	}

	components := []types.TemplateComponent{
		{Type: "body", Parameters: bodyParams},
	}

	if len(msg.Options) > 0 {
		ref := getRefFromMetadata(msg.Metadata)
		buttonParams := make([]types.TemplateComponentParameter, len(msg.Options))
		for i := range msg.Options {
			buttonParams[i] = types.TemplateComponentParameter{Type: "POSTBACK", Payload: ref}
		}
		components = append(components, types.TemplateComponent{Type: "buttons", Parameters: buttonParams})
	}

	return types.MessengerMessage{
		Template: &types.MessageTemplate{
			Name:       template,
			Language:   types.TemplateLanguage{Code: language},
			Components: components,
		},
		Metadata: metadata,
	}, nil
}

// metadataStringSlice reads a []string-ish value out of parsed metadata.
// Non-string elements are stringified (mirrors JS's String(text) in the
// reference translator's params.map(text => ({type: 'text', text: String(text)}))).
func metadataStringSlice(m map[string]interface{}, key string) []string {
	raw, ok := m[key].([]interface{})
	if !ok {
		return nil
	}
	out := make([]string, len(raw))
	for i, item := range raw {
		if s, ok := item.(string); ok {
			out[i] = s
			continue
		}
		out[i] = fmt.Sprintf("%v", item)
	}
	return out
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
