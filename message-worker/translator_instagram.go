package messageworker

import (
	"fmt"

	"github.com/vlab-research/fly/message-worker/types"
)

// TranslateToInstagram translates a platform-agnostic message to Instagram format
// Instagram uses the same API structure as Messenger
func TranslateToInstagram(cmd types.SendMessageCommand) (types.InstagramMessage, error) {
	// Validate message content
	if err := cmd.Message.Validate(); err != nil {
		return types.InstagramMessage{}, err
	}

	switch cmd.Message.Type {
	case types.MessageTypeText:
		return translateInstagramText(cmd.Message)
	case types.MessageTypeQuestion:
		return translateInstagramQuestion(cmd.Message)
	case types.MessageTypeMedia:
		return translateInstagramMedia(cmd.Message)
	default:
		return types.InstagramMessage{}, fmt.Errorf("%w: %s", types.ErrUnsupportedMessageType, cmd.Message.Type)
	}
}

func translateInstagramText(msg types.MessageContent) (types.InstagramMessage, error) {
	return types.InstagramMessage{
		Text: *msg.Text,
	}, nil
}

func translateInstagramQuestion(msg types.MessageContent) (types.InstagramMessage, error) {
	// Instagram supports up to 13 quick replies (same as Messenger)
	const maxQuickReplies = 13

	if len(msg.Options) > maxQuickReplies {
		return types.InstagramMessage{}, fmt.Errorf("%w: Instagram supports max %d quick replies, got %d",
			types.ErrTooManyOptions, maxQuickReplies, len(msg.Options))
	}

	quickReplies := make([]types.QuickReply, len(msg.Options))
	for i, opt := range msg.Options {
		quickReplies[i] = types.QuickReply{
			ContentType: "text",
			Title:       opt.Label,
			Payload:     opt.ValueAsString(),
		}
	}

	return types.InstagramMessage{
		Text:         *msg.QuestionText,
		QuickReplies: quickReplies,
	}, nil
}

func translateInstagramMedia(msg types.MessageContent) (types.InstagramMessage, error) {
	// Map media type to Instagram attachment type
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
		return types.InstagramMessage{}, fmt.Errorf("%w: %s", types.ErrUnsupportedMediaType, *msg.MediaType)
	}

	return types.InstagramMessage{
		Attachment: &types.Attachment{
			Type: attachmentType,
			Payload: types.AttachmentPayload{
				URL: *msg.MediaURL,
			},
		},
	}, nil
}
