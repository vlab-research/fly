package messageworker

import (
	"encoding/json"
	"testing"

	"github.com/vlab-research/fly/message-worker/types"
)

func TestTranslateToInstagram(t *testing.T) {
	tests := []struct {
		name    string
		cmd     types.SendMessageCommand
		want    types.InstagramMessage
		wantErr bool
	}{
		{
			name: "text message",
			cmd: types.SendMessageCommand{
				CommandID:      "cmd_1",
				ConversationID: "conv_1",
				UserID:         "user_1",
				Platform:       types.PlatformInstagram,
				Message: types.MessageContent{
					Type: types.MessageTypeText,
					Text: stringPtr("Hello from Instagram!"),
				},
			},
			want: types.InstagramMessage{
				Text: "Hello from Instagram!",
			},
			wantErr: false,
		},
		{
			name: "question with 5 options",
			cmd: types.SendMessageCommand{
				CommandID:      "cmd_2",
				ConversationID: "conv_1",
				UserID:         "user_1",
				Platform:       types.PlatformInstagram,
				Message: types.MessageContent{
					Type:         types.MessageTypeQuestion,
					QuestionText: stringPtr("Rate your experience:"),
					Options: []types.Option{
						{Value: "1", Label: "⭐"},
						{Value: "2", Label: "⭐⭐"},
						{Value: "3", Label: "⭐⭐⭐"},
						{Value: "4", Label: "⭐⭐⭐⭐"},
						{Value: "5", Label: "⭐⭐⭐⭐⭐"},
					},
				},
			},
			want: types.InstagramMessage{
				Text: "Rate your experience:",
				QuickReplies: []types.QuickReply{
					{ContentType: "text", Title: "⭐", Payload: "1"},
					{ContentType: "text", Title: "⭐⭐", Payload: "2"},
					{ContentType: "text", Title: "⭐⭐⭐", Payload: "3"},
					{ContentType: "text", Title: "⭐⭐⭐⭐", Payload: "4"},
					{ContentType: "text", Title: "⭐⭐⭐⭐⭐", Payload: "5"},
				},
			},
			wantErr: false,
		},
		{
			name: "question with 13 options (max)",
			cmd: types.SendMessageCommand{
				CommandID:      "cmd_3",
				ConversationID: "conv_1",
				UserID:         "user_1",
				Platform:       types.PlatformInstagram,
				Message: types.MessageContent{
					Type:         types.MessageTypeQuestion,
					QuestionText: stringPtr("Select a month:"),
					Options: []types.Option{
						{Value: "1", Label: "January"},
						{Value: "2", Label: "February"},
						{Value: "3", Label: "March"},
						{Value: "4", Label: "April"},
						{Value: "5", Label: "May"},
						{Value: "6", Label: "June"},
						{Value: "7", Label: "July"},
						{Value: "8", Label: "August"},
						{Value: "9", Label: "September"},
						{Value: "10", Label: "October"},
						{Value: "11", Label: "November"},
						{Value: "12", Label: "December"},
						{Value: "0", Label: "Not sure"},
					},
				},
			},
			want: types.InstagramMessage{
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
			name: "question with 14 options (too many)",
			cmd: types.SendMessageCommand{
				CommandID:      "cmd_4",
				ConversationID: "conv_1",
				UserID:         "user_1",
				Platform:       types.PlatformInstagram,
				Message: types.MessageContent{
					Type:         types.MessageTypeQuestion,
					QuestionText: stringPtr("Select an option:"),
					Options: []types.Option{
						{Value: "1", Label: "Option 1"},
						{Value: "2", Label: "Option 2"},
						{Value: "3", Label: "Option 3"},
						{Value: "4", Label: "Option 4"},
						{Value: "5", Label: "Option 5"},
						{Value: "6", Label: "Option 6"},
						{Value: "7", Label: "Option 7"},
						{Value: "8", Label: "Option 8"},
						{Value: "9", Label: "Option 9"},
						{Value: "10", Label: "Option 10"},
						{Value: "11", Label: "Option 11"},
						{Value: "12", Label: "Option 12"},
						{Value: "13", Label: "Option 13"},
						{Value: "14", Label: "Option 14"},
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
				Platform:       types.PlatformInstagram,
				Message: types.MessageContent{
					Type:      types.MessageTypeMedia,
					MediaType: mediaTypePtr(types.MediaTypeImage),
					MediaURL:  stringPtr("https://example.com/image.jpg"),
				},
			},
			want: types.InstagramMessage{
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
				Platform:       types.PlatformInstagram,
				Message: types.MessageContent{
					Type:      types.MessageTypeMedia,
					MediaType: mediaTypePtr(types.MediaTypeVideo),
					MediaURL:  stringPtr("https://example.com/video.mp4"),
				},
			},
			want: types.InstagramMessage{
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
				Platform:       types.PlatformInstagram,
				Message: types.MessageContent{
					Type: types.MessageTypeText,
					Text: nil,
				},
			},
			wantErr: true,
		},
		{
			name: "missing options",
			cmd: types.SendMessageCommand{
				CommandID:      "cmd_8",
				ConversationID: "conv_1",
				UserID:         "user_1",
				Platform:       types.PlatformInstagram,
				Message: types.MessageContent{
					Type:         types.MessageTypeQuestion,
					QuestionText: stringPtr("Select one:"),
					Options:      []types.Option{},
				},
			},
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := TranslateToInstagram(tt.cmd)
			if (err != nil) != tt.wantErr {
				t.Errorf("TranslateToInstagram() error = %v, wantErr %v", err, tt.wantErr)
				return
			}
			if !tt.wantErr {
				// Compare JSON representations for deep equality
				gotJSON, _ := json.Marshal(got)
				wantJSON, _ := json.Marshal(tt.want)
				if string(gotJSON) != string(wantJSON) {
					t.Errorf("TranslateToInstagram() = %s, want %s", gotJSON, wantJSON)
				}
			}
		})
	}
}
