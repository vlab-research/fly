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
						URL: "https://example.com/image.jpg",
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
						URL: "https://example.com/video.mp4",
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
