package messageworker

import (
	"encoding/json"
	"testing"

	"github.com/vlab-research/fly/message-worker/types"
)

func stringPtr(s string) *string {
	return &s
}

func mediaTypePtr(m types.MediaType) *types.MediaType {
	return &m
}

func boolPtr(b bool) *bool {
	return &b
}

func TestTranslateToMessenger(t *testing.T) {
	tests := []struct {
		name    string
		cmd     types.SendMessageCommand
		want    types.MessengerMessage
		wantErr bool
	}{
		{
			name: "text message",
			cmd: types.SendMessageCommand{
				CommandID:      "cmd_1",
				ConversationID: "conv_1",
				UserID:         "user_1",
				Platform:       types.PlatformMessenger,
				Message: types.MessageContent{
					Type: types.MessageTypeText,
					Text: stringPtr("Hello, world!"),
				},
			},
			want: types.MessengerMessage{
				Text: "Hello, world!",
			},
			wantErr: false,
		},
		{
			name: "question with 3 options",
			cmd: types.SendMessageCommand{
				CommandID:      "cmd_2",
				ConversationID: "conv_1",
				UserID:         "user_1",
				Platform:       types.PlatformMessenger,
				Message: types.MessageContent{
					Type:         types.MessageTypeQuestion,
					QuestionText: stringPtr("What is your gender?"),
					Options: []types.Option{
						{Value: json.RawMessage(`"male"`), Label: "Male"},
						{Value: json.RawMessage(`"female"`), Label: "Female"},
						{Value: json.RawMessage(`"other"`), Label: "Other"},
					},
				},
			},
			want: types.MessengerMessage{
				Text: "What is your gender?",
				QuickReplies: []types.QuickReply{
					{ContentType: "text", Title: "Male", Payload: "male"},
					{ContentType: "text", Title: "Female", Payload: "female"},
					{ContentType: "text", Title: "Other", Payload: "other"},
				},
			},
			wantErr: false,
		},
		{
			name: "question with 13 options (max allowed)",
			cmd: types.SendMessageCommand{
				CommandID:      "cmd_3",
				ConversationID: "conv_1",
				UserID:         "user_1",
				Platform:       types.PlatformMessenger,
				Message: types.MessageContent{
					Type:         types.MessageTypeQuestion,
					QuestionText: stringPtr("Select a month:"),
					Options: []types.Option{
						{Value: json.RawMessage(`"1"`), Label: "January"},
						{Value: json.RawMessage(`"2"`), Label: "February"},
						{Value: json.RawMessage(`"3"`), Label: "March"},
						{Value: json.RawMessage(`"4"`), Label: "April"},
						{Value: json.RawMessage(`"5"`), Label: "May"},
						{Value: json.RawMessage(`"6"`), Label: "June"},
						{Value: json.RawMessage(`"7"`), Label: "July"},
						{Value: json.RawMessage(`"8"`), Label: "August"},
						{Value: json.RawMessage(`"9"`), Label: "September"},
						{Value: json.RawMessage(`"10"`), Label: "October"},
						{Value: json.RawMessage(`"11"`), Label: "November"},
						{Value: json.RawMessage(`"12"`), Label: "December"},
						{Value: json.RawMessage(`"0"`), Label: "Not sure"},
					},
				},
			},
			want: types.MessengerMessage{
				Text: "Select a month:",
				QuickReplies: []types.QuickReply{
					{ContentType: "text", Title: "January", Payload: "1"},
					{ContentType: "text", Title: "February", Payload: "2"},
					{ContentType: "text", Title: "March", Payload: "3"},
					{ContentType: "text", Title: "April", Payload: "4"},
					{ContentType: "text", Title: "May", Payload: "5"},
					{ContentType: "text", Title: "June", Payload: "6"},
					{ContentType: "text", Title: "July", Payload: "7"},
					{ContentType: "text", Title: "August", Payload: "8"},
					{ContentType: "text", Title: "September", Payload: "9"},
					{ContentType: "text", Title: "October", Payload: "10"},
					{ContentType: "text", Title: "November", Payload: "11"},
					{ContentType: "text", Title: "December", Payload: "12"},
					{ContentType: "text", Title: "Not sure", Payload: "0"},
				},
			},
			wantErr: false,
		},
		{
			name: "question with too many options (14)",
			cmd: types.SendMessageCommand{
				CommandID:      "cmd_4",
				ConversationID: "conv_1",
				UserID:         "user_1",
				Platform:       types.PlatformMessenger,
				Message: types.MessageContent{
					Type:         types.MessageTypeQuestion,
					QuestionText: stringPtr("Select an option:"),
					Options: []types.Option{
						{Value: json.RawMessage(`"1"`), Label: "Option 1"},
						{Value: json.RawMessage(`"2"`), Label: "Option 2"},
						{Value: json.RawMessage(`"3"`), Label: "Option 3"},
						{Value: json.RawMessage(`"4"`), Label: "Option 4"},
						{Value: json.RawMessage(`"5"`), Label: "Option 5"},
						{Value: json.RawMessage(`"6"`), Label: "Option 6"},
						{Value: json.RawMessage(`"7"`), Label: "Option 7"},
						{Value: json.RawMessage(`"8"`), Label: "Option 8"},
						{Value: json.RawMessage(`"9"`), Label: "Option 9"},
						{Value: json.RawMessage(`"10"`), Label: "Option 10"},
						{Value: json.RawMessage(`"11"`), Label: "Option 11"},
						{Value: json.RawMessage(`"12"`), Label: "Option 12"},
						{Value: json.RawMessage(`"13"`), Label: "Option 13"},
						{Value: json.RawMessage(`"14"`), Label: "Option 14"},
					},
				},
			},
			wantErr: true,
		},
		{
			name: "image message",
			cmd: types.SendMessageCommand{
				CommandID:      "cmd_5",
				ConversationID: "conv_1",
				UserID:         "user_1",
				Platform:       types.PlatformMessenger,
				Message: types.MessageContent{
					Type:      types.MessageTypeMedia,
					MediaType: mediaTypePtr(types.MediaTypeImage),
					MediaURL:  stringPtr("https://example.com/image.jpg"),
				},
			},
			want: types.MessengerMessage{
				Attachment: &types.Attachment{
					Type: "image",
					Payload: types.AttachmentPayload{
						URL:        "https://example.com/image.jpg",
						IsReusable: boolPtr(true),
					},
				},
			},
			wantErr: false,
		},
		{
			name: "video message",
			cmd: types.SendMessageCommand{
				CommandID:      "cmd_6",
				ConversationID: "conv_1",
				UserID:         "user_1",
				Platform:       types.PlatformMessenger,
				Message: types.MessageContent{
					Type:      types.MessageTypeMedia,
					MediaType: mediaTypePtr(types.MediaTypeVideo),
					MediaURL:  stringPtr("https://example.com/video.mp4"),
				},
			},
			want: types.MessengerMessage{
				Attachment: &types.Attachment{
					Type: "video",
					Payload: types.AttachmentPayload{
						URL:        "https://example.com/video.mp4",
						IsReusable: boolPtr(true),
					},
				},
			},
			wantErr: false,
		},
		{
			name: "missing text field",
			cmd: types.SendMessageCommand{
				CommandID:      "cmd_7",
				ConversationID: "conv_1",
				UserID:         "user_1",
				Platform:       types.PlatformMessenger,
				Message: types.MessageContent{
					Type: types.MessageTypeText,
					Text: nil,
				},
			},
			wantErr: true,
		},
		{
			name: "missing question text",
			cmd: types.SendMessageCommand{
				CommandID:      "cmd_8",
				ConversationID: "conv_1",
				UserID:         "user_1",
				Platform:       types.PlatformMessenger,
				Message: types.MessageContent{
					Type:    types.MessageTypeQuestion,
					Options: []types.Option{{Value: json.RawMessage(`"yes"`), Label: "Yes"}},
				},
			},
			wantErr: true,
		},
		{
			name: "phone field (no quick reply)",
			cmd: types.SendMessageCommand{
				CommandID:      "cmd_9",
				ConversationID: "conv_1",
				UserID:         "user_1",
				Platform:       types.PlatformMessenger,
				Message: types.MessageContent{
					Type:     types.MessageTypeText,
					Text:     stringPtr("What is your phone number?"),
					Metadata: json.RawMessage(`{"type":"phone_number","ref":"phone_1"}`),
				},
			},
			want: types.MessengerMessage{
				Text:     "What is your phone number?",
				Metadata: `{"type":"phone_number","ref":"phone_1"}`,
				// Note: NO QuickReplies for phone field
			},
			wantErr: false,
		},
		{
			// Email renders as plain text (no user_email quick reply), matching
			// translate-typeform (translateEmail = translateShortText) and the
			// plain-text treatment of native input fields (cf. phone_number).
			name: "email field (plain text, no quick reply)",
			cmd: types.SendMessageCommand{
				CommandID:      "cmd_10",
				ConversationID: "conv_1",
				UserID:         "user_1",
				Platform:       types.PlatformMessenger,
				Message: types.MessageContent{
					Type:     types.MessageTypeText,
					Text:     stringPtr("What is your email?"),
					Metadata: json.RawMessage(`{"type":"email","ref":"email_1"}`),
				},
			},
			want: types.MessengerMessage{
				Text:     "What is your email?",
				Metadata: `{"type":"email","ref":"email_1"}`,
			},
			wantErr: false,
		},
		{
			name: "webview field renders as button template",
			cmd: types.SendMessageCommand{
				CommandID: "cmd_11",
				Platform:  types.PlatformMessenger,
				Message: types.MessageContent{
					Type:     types.MessageTypeText,
					Text:     stringPtr("Take a look!"),
					Metadata: json.RawMessage(`{"type":"webview","url":"https://example.com","buttonText":"Visit","extensions":false,"ref":"wv_1"}`),
				},
			},
			want: types.MessengerMessage{
				Attachment: &types.Attachment{
					Type: "template",
					Payload: types.TemplatePayload{
						TemplateType: "button",
						Text:         "Take a look!",
						Buttons: []types.Button{{
							Type:                "web_url",
							URL:                 "https://example.com",
							Title:               "Visit",
							WebviewHeightRatio:  "full",
							MessengerExtensions: boolPtr(false),
						}},
					},
				},
				Metadata: `{"type":"webview","url":"https://example.com","buttonText":"Visit","extensions":false,"ref":"wv_1"}`,
			},
			wantErr: false,
		},
		{
			name: "webview defaults messenger_extensions to true",
			cmd: types.SendMessageCommand{
				CommandID: "cmd_12",
				Platform:  types.PlatformMessenger,
				Message: types.MessageContent{
					Type:     types.MessageTypeText,
					Text:     stringPtr("Watch this"),
					Metadata: json.RawMessage(`{"type":"webview","url":"https://example.com/v","buttonText":"Play","ref":"wv_2"}`),
				},
			},
			want: types.MessengerMessage{
				Attachment: &types.Attachment{
					Type: "template",
					Payload: types.TemplatePayload{
						TemplateType: "button",
						Text:         "Watch this",
						Buttons: []types.Button{{
							Type:                "web_url",
							URL:                 "https://example.com/v",
							Title:               "Play",
							WebviewHeightRatio:  "full",
							MessengerExtensions: boolPtr(true),
						}},
					},
				},
				Metadata: `{"type":"webview","url":"https://example.com/v","buttonText":"Play","ref":"wv_2"}`,
			},
			wantErr: false,
		},
		{
			name: "notify field renders as one_time_notif_req template",
			cmd: types.SendMessageCommand{
				CommandID: "cmd_13",
				Platform:  types.PlatformMessenger,
				Message: types.MessageContent{
					Type:     types.MessageTypeText,
					Text:     stringPtr("Can we message you again?"),
					Metadata: json.RawMessage(`{"type":"notify","ref":"nt_1"}`),
				},
			},
			want: types.MessengerMessage{
				Attachment: &types.Attachment{
					Type: "template",
					Payload: types.TemplatePayload{
						TemplateType: "one_time_notif_req",
						Title:        "Can we message you again?",
						Payload:      `{"ref":"nt_1"}`,
					},
				},
				Metadata: `{"type":"notify","ref":"nt_1"}`,
			},
			wantErr: false,
		},
		{
			// replybot's translateUtilityMessage (generic-translator.js) emits a
			// utility_message field with no choices as base type "text"
			// (translateTextField). The metadata.type=="utility_message"
			// discriminator must still route it to the template builder.
			name: "utility_message with no choices renders as message template (no buttons component)",
			cmd: types.SendMessageCommand{
				CommandID: "cmd_util_1",
				Platform:  types.PlatformMessenger,
				Message: types.MessageContent{
					Type:     types.MessageTypeText,
					Text:     stringPtr("Payment update"),
					Metadata: json.RawMessage(`{"type":"utility_message","template":"recontact_owis","language":"en_US","params":["KSh 35"],"ref":"utility_1"}`),
				},
			},
			want: types.MessengerMessage{
				Template: &types.MessageTemplate{
					Name:     "recontact_owis",
					Language: types.TemplateLanguage{Code: "en_US"},
					Components: []types.TemplateComponent{
						{
							Type: "body",
							Parameters: []types.TemplateComponentParameter{
								{Type: "text", Text: "KSh 35"},
							},
						},
					},
				},
				Metadata: `{"type":"utility_message","template":"recontact_owis","language":"en_US","params":["KSh 35"],"ref":"utility_1"}`,
			},
			wantErr: false,
		},
		{
			// With choices, replybot emits utility_message as base type
			// "question" (translateUtilityMessage's choices branch). Buttons
			// component gets one {type: POSTBACK, payload: ref} per choice --
			// same ref value repeated, per the reference translator.
			name: "utility_message with choices renders as message template with buttons component",
			cmd: types.SendMessageCommand{
				CommandID: "cmd_util_2",
				Platform:  types.PlatformMessenger,
				Message: types.MessageContent{
					Type:         types.MessageTypeQuestion,
					QuestionText: stringPtr("Can you make it at 10:00?"),
					Options: []types.Option{
						{Value: json.RawMessage(`"utility_2"`), Label: "Yes"},
						{Value: json.RawMessage(`"utility_2"`), Label: "No"},
					},
					Metadata: json.RawMessage(`{"type":"utility_message","template":"recontact_confirm","language":"en_US","params":["10:00"],"ref":"utility_2"}`),
				},
			},
			want: types.MessengerMessage{
				Template: &types.MessageTemplate{
					Name:     "recontact_confirm",
					Language: types.TemplateLanguage{Code: "en_US"},
					Components: []types.TemplateComponent{
						{
							Type: "body",
							Parameters: []types.TemplateComponentParameter{
								{Type: "text", Text: "10:00"},
							},
						},
						{
							Type: "buttons",
							Parameters: []types.TemplateComponentParameter{
								{Type: "POSTBACK", Payload: "utility_2"},
								{Type: "POSTBACK", Payload: "utility_2"},
							},
						},
					},
				},
				Metadata: `{"type":"utility_message","template":"recontact_confirm","language":"en_US","params":["10:00"],"ref":"utility_2"}`,
			},
			wantErr: false,
		},
		{
			name: "utility_message missing template in metadata errors",
			cmd: types.SendMessageCommand{
				CommandID: "cmd_util_3",
				Platform:  types.PlatformMessenger,
				Message: types.MessageContent{
					Type:     types.MessageTypeText,
					Text:     stringPtr("x"),
					Metadata: json.RawMessage(`{"type":"utility_message","language":"en_US","ref":"utility_3"}`),
				},
			},
			wantErr: true,
		},
		{
			name: "utility_message missing language in metadata errors",
			cmd: types.SendMessageCommand{
				CommandID: "cmd_util_4",
				Platform:  types.PlatformMessenger,
				Message: types.MessageContent{
					Type:     types.MessageTypeText,
					Text:     stringPtr("x"),
					Metadata: json.RawMessage(`{"type":"utility_message","template":"recontact_owis","ref":"utility_4"}`),
				},
			},
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := TranslateToMessenger(tt.cmd)
			if (err != nil) != tt.wantErr {
				t.Errorf("TranslateToMessenger() error = %v, wantErr %v", err, tt.wantErr)
				return
			}
			if !tt.wantErr {
				gotJSON, _ := json.Marshal(got)
				wantJSON, _ := json.Marshal(tt.want)
				if string(gotJSON) != string(wantJSON) {
					t.Errorf("TranslateToMessenger() = %s, want %s", gotJSON, wantJSON)
				}
			}
		})
	}
}

// TestGetMessengerSendParams locks the seam that surfaces Facebook's
// top-level Send API fields (messaging_type, tag) — which cannot live on
// MessengerMessage/message.template itself since Facebook puts them as
// siblings of "message" on the request. utility_message always forces
// messaging_type=UTILITY (message-worker's own concern); everything else
// gets its messaging_type/tag from the field's sendParams metadata, which
// replybot's transition.js buildCommands nests at message.metadata.sendParams
// (see transition.test.js "carries sendParams (message-tag) through...").
func TestGetMessengerSendParams(t *testing.T) {
	tests := []struct {
		name              string
		cmd               types.SendMessageCommand
		wantMessagingType string
		wantTag           string
	}{
		{
			name: "utility_message forces UTILITY messaging_type regardless of sendParams",
			cmd: types.SendMessageCommand{
				Message: types.MessageContent{
					Type:     types.MessageTypeText,
					Text:     stringPtr("x"),
					Metadata: json.RawMessage(`{"type":"utility_message","template":"t","language":"en_US","sendParams":{"messaging_type":"MESSAGE_TAG","tag":"SHOULD_BE_IGNORED"}}`),
				},
			},
			wantMessagingType: "UTILITY",
			wantTag:           "",
		},
		{
			name: "sendParams metadata surfaces messaging_type and tag",
			cmd: types.SendMessageCommand{
				Message: types.MessageContent{
					Type:     types.MessageTypeText,
					Text:     stringPtr("x"),
					Metadata: json.RawMessage(`{"sendParams":{"messaging_type":"MESSAGE_TAG","tag":"CONFIRMED_EVENT_UPDATE"}}`),
				},
			},
			wantMessagingType: "MESSAGE_TAG",
			wantTag:           "CONFIRMED_EVENT_UPDATE",
		},
		{
			name: "no metadata yields empty messaging_type and tag",
			cmd: types.SendMessageCommand{
				Message: types.MessageContent{
					Type: types.MessageTypeText,
					Text: stringPtr("x"),
				},
			},
			wantMessagingType: "",
			wantTag:           "",
		},
		{
			name: "metadata with unrelated fields (e.g. webview) yields empty messaging_type and tag",
			cmd: types.SendMessageCommand{
				Message: types.MessageContent{
					Type:     types.MessageTypeText,
					Text:     stringPtr("x"),
					Metadata: json.RawMessage(`{"type":"webview","url":"https://example.com","ref":"wv_1"}`),
				},
			},
			wantMessagingType: "",
			wantTag:           "",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			gotMessagingType, gotTag := getMessengerSendParams(tt.cmd)
			if gotMessagingType != tt.wantMessagingType {
				t.Errorf("messagingType = %q, want %q", gotMessagingType, tt.wantMessagingType)
			}
			if gotTag != tt.wantTag {
				t.Errorf("tag = %q, want %q", gotTag, tt.wantTag)
			}
		})
	}
}
