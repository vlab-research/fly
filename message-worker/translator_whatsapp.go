package messageworker

import (
	"fmt"
	"strconv"
	"strings"
	"unicode/utf8"

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
		// Some field types arrive as platform-agnostic "text" but render as
		// something richer per platform. webview is one: replybot puts the
		// destination in metadata.url and only the prose in text, so a plain
		// text send would silently drop the link. Mirrors the same dispatch in
		// translateMessengerText.
		if cmd.Message.GetTypeFromMetadata() == "webview" {
			return translateWhatsAppWebview(cmd.Message)
		}
		return translateWhatsAppText(cmd.Message)
	case types.MessageTypeQuestion:
		return translateWhatsAppQuestion(cmd.Message)
	case types.MessageTypeMedia:
		return translateWhatsAppMedia(cmd.Message, cmd.ResolvedMedia)
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

// translateWhatsAppWebview renders a webview field as a cta_url interactive
// message: the field title as the body, metadata.buttonText as the button
// label, and metadata.url hidden behind it. This is the closest WhatsApp
// equivalent of the Messenger web_url button template built by
// translateMessengerWebview, and it keeps the tracking params in
// links.vlab.digital URLs off the user's screen.
//
// Unlike the Messenger path this can fail, by design. WhatsApp caps
// display_text at 20 characters and rejects the entire message when it is
// longer, so an over-long buttonText is reported as a STATE_ACTIONS error
// naming the field and the label — visible in the dashboard — rather than
// being truncated into something that no longer says what it meant.
//
// metadata.extensions is ignored: it sets messenger_extensions on the
// Messenger button and has no WhatsApp counterpart.
func translateWhatsAppWebview(msg types.MessageContent) (types.WhatsAppMessage, error) {
	md := metadataMap(msg.Metadata)
	ref := getRefFromMetadata(msg.Metadata)

	rawURL := metadataString(md, "url")
	if rawURL == "" {
		return types.WhatsAppMessage{}, fmt.Errorf("%w (field %q)", types.ErrMissingWebviewURL, ref)
	}

	url, err := normalizeWebviewURL(rawURL, ref)
	if err != nil {
		return types.WhatsAppMessage{}, err
	}

	buttonText := metadataString(md, "buttonText")
	if buttonText == "" {
		buttonText = "View website"
	}
	if n := utf8.RuneCountInString(buttonText); n > types.WhatsAppCTAButtonTextMaxChars {
		return types.WhatsAppMessage{}, fmt.Errorf(
			"%w (field %q): buttonText %q is %d characters, max %d",
			types.ErrWebviewButtonTextTooLong, ref, buttonText, n, types.WhatsAppCTAButtonTextMaxChars)
	}

	return types.WhatsAppMessage{
		Type: "interactive",
		Interactive: &types.WhatsAppInteractive{
			Type: "cta_url",
			Body: types.WhatsAppText{
				Text: *msg.Text,
			},
			Action: types.WhatsAppAction{
				Name: "cta_url",
				Parameters: &types.WhatsAppCTAParams{
					DisplayText: buttonText,
					URL:         url,
				},
			},
		},
	}, nil
}

// normalizeWebviewURL makes a webview url safe to hand to cta_url, which
// loads it in the device browser and so needs an absolute http(s) URL.
//
// Scheme-less URLs are real in production ("bit.ly/wazzii",
// "www.youtube.com/..."): translate-typeform's makeUrl passes string urls
// through untouched while defaulting the object form to https, so the two
// spellings of the same link disagree. Default them to https the same way
// rather than failing on forms that work elsewhere.
//
// Any other scheme is an error. tel:/mailto:/sms: destinations are expected to
// go through linksniffer's "p" param, which yields an https links.vlab.digital
// URL that redirects — so a bare tel: here is a form authoring mistake worth
// surfacing, not something to pass to WhatsApp and have rejected opaquely.
func normalizeWebviewURL(rawURL, ref string) (string, error) {
	lower := strings.ToLower(rawURL)

	if strings.HasPrefix(lower, "http://") || strings.HasPrefix(lower, "https://") {
		return rawURL, nil
	}

	// A scheme is "<alpha><alnum|+|-|.>*:" before any "/" — anything else
	// (bit.ly/x, www.youtube.com/watch?v=..., a bare host) is scheme-less.
	if i := strings.IndexAny(lower, ":/"); i > 0 && lower[i] == ':' && isURLScheme(lower[:i]) {
		return "", fmt.Errorf(
			"%w (field %q): %q — use linksniffer's \"p\" param for non-http destinations",
			types.ErrWebviewURLScheme, ref, rawURL)
	}

	return "https://" + rawURL, nil
}

func isURLScheme(s string) bool {
	if s == "" || !isASCIILetter(s[0]) {
		return false
	}
	for i := 1; i < len(s); i++ {
		c := s[i]
		if !isASCIILetter(c) && !(c >= '0' && c <= '9') && c != '+' && c != '-' && c != '.' {
			return false
		}
	}
	return true
}

func isASCIILetter(c byte) bool {
	return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
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

func translateWhatsAppMedia(msg types.MessageContent, resolved *types.MediaSendable) (types.WhatsAppMessage, error) {
	if types.Blank(msg.MediaURL) {
		return types.WhatsAppMessage{}, types.ErrAttachmentIDUnsupported
	}

	media := types.WhatsAppMedia{}
	if resolved != nil && resolved.Kind == types.MediaByID {
		media.ID = resolved.ID
	} else {
		media.Link = *msg.MediaURL
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
