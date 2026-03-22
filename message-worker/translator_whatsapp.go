package messageworker

import (
	"fmt"

	"github.com/vlab-research/fly/message-worker/types"
)

// TranslateToWhatsApp translates a platform-agnostic message to WhatsApp format
func TranslateToWhatsApp(cmd types.SendMessageCommand) (types.WhatsAppMessage, error) {
	// Validate message content
	if err := cmd.Message.Validate(); err != nil {
		return types.WhatsAppMessage{}, err
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
