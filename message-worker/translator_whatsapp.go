package messageworker

import (
	"fmt"
	"strconv"

	"github.com/vlab-research/fly/message-worker/types"
)

// TranslateToWhatsApp translates a platform-agnostic message to WhatsApp format
func TranslateToWhatsApp(cmd types.SendMessageCommand) (types.WhatsAppMessage, error) {
	// Validate message content
	if err := cmd.Message.Validate(); err != nil {
		return types.WhatsAppMessage{}, err
	}

	// utility_message (the out-of-window re-contact mechanism) is dispatched
	// ahead of the base-type switch, mirroring TranslateToMessenger: replybot
	// emits it as base type "question" when the field has choices and "text"
	// when it doesn't — the metadata.type discriminator identifies it, not
	// MessageContent.Type. WhatsApp only allows free-form sends within 24h of
	// the user's last message; outside that window only a pre-approved
	// template (type: "template") is deliverable.
	if cmd.Message.GetTypeFromMetadata() == "utility_message" {
		return translateWhatsAppTemplate(cmd.Message)
	}

	switch cmd.Message.Type {
	case types.MessageTypeText:
		return translateWhatsAppText(cmd.Message)
	case types.MessageTypeQuestion:
		return translateWhatsAppQuestion(cmd.Message)
	case types.MessageTypeMedia:
		return translateWhatsAppMedia(cmd.Message)
	default:
		return types.WhatsAppMessage{}, fmt.Errorf("%w: %s", types.ErrUnsupportedMessageType, cmd.Message.Type)
	}
}

// translateWhatsAppTemplate renders a utility_message field as a WhatsApp
// Cloud API template send. template/language/params come from the field's
// metadata (same contract as the Messenger utility path:
// {"type":"utility_message","template":...,"language":...,"params":[...],"ref":...});
// buttons come from the field's own choices/options.
//
// Differences from translateMessengerUtility, both mandated by WhatsApp's API:
//   - the body component is OMITTED when there are no params (WhatsApp
//     rejects a body component with an empty parameters array, whereas
//     Messenger requires body to always be present);
//   - each button is its OWN component {type: "button", sub_type:
//     "quick_reply", index: "<i>"} (Messenger uses a single "buttons"
//     component and rejects the per-button index shape).
//
// Each button's payload carries the same JSON that Messenger quick replies
// deliver — {"value":<option value>,"ref":"<field ref>"} via
// buildQuickReplyPayload — so the inbound webhook's button payload parses
// through replybot's existing quick-reply handling unchanged.
func translateWhatsAppTemplate(msg types.MessageContent) (types.WhatsAppMessage, error) {
	md := metadataMap(msg.Metadata)

	template := metadataString(md, "template")
	if template == "" {
		return types.WhatsAppMessage{}, fmt.Errorf("%w", types.ErrMissingUtilityTemplate)
	}
	language := metadataString(md, "language")
	if language == "" {
		return types.WhatsAppMessage{}, fmt.Errorf("%w", types.ErrMissingUtilityLanguage)
	}

	var components []types.WhatsAppTemplateComponent

	params := metadataStringSlice(md, "params")
	if len(params) > 0 {
		bodyParams := make([]types.WhatsAppTemplateParameter, len(params))
		for i, p := range params {
			bodyParams[i] = types.WhatsAppTemplateParameter{Type: "text", Text: p}
		}
		components = append(components, types.WhatsAppTemplateComponent{
			Type:       "body",
			Parameters: bodyParams,
		})
	}

	if len(msg.Options) > 0 {
		ref := getRefFromMetadata(msg.Metadata)
		for i, opt := range msg.Options {
			components = append(components, types.WhatsAppTemplateComponent{
				Type:    "button",
				SubType: "quick_reply",
				Index:   strconv.Itoa(i),
				Parameters: []types.WhatsAppTemplateParameter{
					{Type: "payload", Payload: buildQuickReplyPayload(opt.Value, ref)},
				},
			})
		}
	}

	return types.WhatsAppMessage{
		Type: "template",
		Template: &types.WhatsAppTemplate{
			Name:       template,
			Language:   types.WhatsAppTemplateLanguage{Code: language},
			Components: components,
		},
	}, nil
}

func translateWhatsAppText(msg types.MessageContent) (types.WhatsAppMessage, error) {
	return types.WhatsAppMessage{
		Type: "text",
		Text: &types.WhatsAppText{
			Body: *msg.Text,
		},
	}, nil
}

func translateWhatsAppQuestion(msg types.MessageContent) (types.WhatsAppMessage, error) {
	const maxButtons = 3
	const maxListItems = 10

	optionCount := len(msg.Options)

	// Use buttons for 1-3 options
	if optionCount <= maxButtons {
		return translateWhatsAppButtons(msg)
	}

	// Use list for 4-10 options
	if optionCount <= maxListItems {
		return translateWhatsAppList(msg)
	}

	// Too many options
	return types.WhatsAppMessage{}, fmt.Errorf("%w: WhatsApp supports max %d options in a list, got %d",
		types.ErrTooManyOptions, maxListItems, optionCount)
}

func translateWhatsAppButtons(msg types.MessageContent) (types.WhatsAppMessage, error) {
	buttons := make([]types.WhatsAppButton, len(msg.Options))
	for i, opt := range msg.Options {
		buttons[i] = types.WhatsAppButton{
			Type: "reply",
			Reply: types.WhatsAppButtonReply{
				ID:    opt.ValueAsString(),
				Title: opt.Label,
			},
		}
	}

	return types.WhatsAppMessage{
		Type: "interactive",
		Interactive: &types.WhatsAppInteractive{
			Type: "button",
			Body: types.WhatsAppText{
				Text: *msg.QuestionText,
			},
			Action: types.WhatsAppAction{
				Buttons: buttons,
			},
		},
	}, nil
}

func translateWhatsAppList(msg types.MessageContent) (types.WhatsAppMessage, error) {
	rows := make([]types.WhatsAppRow, len(msg.Options))
	for i, opt := range msg.Options {
		rows[i] = types.WhatsAppRow{
			ID:    opt.ValueAsString(),
			Title: opt.Label,
		}
	}

	return types.WhatsAppMessage{
		Type: "interactive",
		Interactive: &types.WhatsAppInteractive{
			Type: "list",
			Body: types.WhatsAppText{
				Text: *msg.QuestionText,
			},
			Action: types.WhatsAppAction{
				Button: "Choose",
				Sections: []types.WhatsAppSection{
					{
						Rows: rows,
					},
				},
			},
		},
	}, nil
}

func translateWhatsAppMedia(msg types.MessageContent) (types.WhatsAppMessage, error) {
	media := types.WhatsAppMedia{
		Link: *msg.MediaURL,
	}
	if msg.Caption != nil {
		media.Caption = *msg.Caption
	}

	var whatsappMsg types.WhatsAppMessage

	switch *msg.MediaType {
	case types.MediaTypeImage:
		whatsappMsg = types.WhatsAppMessage{
			Type:  "image",
			Image: &media,
		}
	case types.MediaTypeVideo:
		whatsappMsg = types.WhatsAppMessage{
			Type:  "video",
			Video: &media,
		}
	case types.MediaTypeAudio:
		whatsappMsg = types.WhatsAppMessage{
			Type:  "audio",
			Audio: &media,
		}
	case types.MediaTypeFile:
		whatsappMsg = types.WhatsAppMessage{
			Type:     "document",
			Document: &media,
		}
	default:
		return types.WhatsAppMessage{}, fmt.Errorf("%w: %s", types.ErrUnsupportedMediaType, *msg.MediaType)
	}

	return whatsappMsg, nil
}
