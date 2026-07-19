package messageworker

import (
	"encoding/json"
	"testing"

	"github.com/vlab-research/fly/message-worker/types"
)

func TestTranslateToWhatsApp(t *testing.T) {
	tests := []struct {
		name    string
		cmd     types.SendMessageCommand
		want    types.WhatsAppMessage
		wantErr bool
	}{
		{
			name: "text message",
			cmd: types.SendMessageCommand{
				CommandID:      "cmd_1",
				ConversationID: "conv_1",
				UserID:         "user_1",
				Platform:       types.PlatformWhatsApp,
				Message: types.MessageContent{
					Type: types.MessageTypeText,
					Text: stringPtr("Hello from WhatsApp!"),
				},
			},
			want: types.WhatsAppMessage{
				Type: "text",
				Text: &types.WhatsAppText{
					Body: "Hello from WhatsApp!",
				},
			},
			wantErr: false,
		},
		{
			name: "question with 2 options (buttons)",
			cmd: types.SendMessageCommand{
				CommandID:      "cmd_2",
				ConversationID: "conv_1",
				UserID:         "user_1",
				Platform:       types.PlatformWhatsApp,
				Message: types.MessageContent{
					Type:         types.MessageTypeQuestion,
					QuestionText: stringPtr("Do you agree?"),
					Options: []types.Option{
						{Value: json.RawMessage(`"yes"`), Label: "Yes"},
						{Value: json.RawMessage(`"no"`), Label: "No"},
					},
				},
			},
			want: types.WhatsAppMessage{
				Type: "interactive",
				Interactive: &types.WhatsAppInteractive{
					Type: "button",
					Body: types.WhatsAppText{
						Text: "Do you agree?",
					},
					Action: types.WhatsAppAction{
						Buttons: []types.WhatsAppButton{
							{
								Type: "reply",
								Reply: types.WhatsAppButtonReply{
									ID:    "yes",
									Title: "Yes",
								},
							},
							{
								Type: "reply",
								Reply: types.WhatsAppButtonReply{
									ID:    "no",
									Title: "No",
								},
							},
						},
					},
				},
			},
			wantErr: false,
		},
		{
			name: "question with 3 options (buttons, max)",
			cmd: types.SendMessageCommand{
				CommandID:      "cmd_3",
				ConversationID: "conv_1",
				UserID:         "user_1",
				Platform:       types.PlatformWhatsApp,
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
			want: types.WhatsAppMessage{
				Type: "interactive",
				Interactive: &types.WhatsAppInteractive{
					Type: "button",
					Body: types.WhatsAppText{
						Text: "What is your gender?",
					},
					Action: types.WhatsAppAction{
						Buttons: []types.WhatsAppButton{
							{Type: "reply", Reply: types.WhatsAppButtonReply{ID: "male", Title: "Male"}},
							{Type: "reply", Reply: types.WhatsAppButtonReply{ID: "female", Title: "Female"}},
							{Type: "reply", Reply: types.WhatsAppButtonReply{ID: "other", Title: "Other"}},
						},
					},
				},
			},
			wantErr: false,
		},
		{
			name: "question with 4 options (list)",
			cmd: types.SendMessageCommand{
				CommandID:      "cmd_4",
				ConversationID: "conv_1",
				UserID:         "user_1",
				Platform:       types.PlatformWhatsApp,
				Message: types.MessageContent{
					Type:         types.MessageTypeQuestion,
					QuestionText: stringPtr("Select your age range:"),
					Options: []types.Option{
						{Value: json.RawMessage(`"18-24"`), Label: "18-24"},
						{Value: json.RawMessage(`"25-34"`), Label: "25-34"},
						{Value: json.RawMessage(`"35-44"`), Label: "35-44"},
						{Value: json.RawMessage(`"45+"`), Label: "45+"},
					},
				},
			},
			want: types.WhatsAppMessage{
				Type: "interactive",
				Interactive: &types.WhatsAppInteractive{
					Type: "list",
					Body: types.WhatsAppText{
						Text: "Select your age range:",
					},
					Action: types.WhatsAppAction{
						Button: "Choose",
						Sections: []types.WhatsAppSection{
							{
								Rows: []types.WhatsAppRow{
									{ID: "18-24", Title: "18-24"},
									{ID: "25-34", Title: "25-34"},
									{ID: "35-44", Title: "35-44"},
									{ID: "45+", Title: "45+"},
								},
							},
						},
					},
				},
			},
			wantErr: false,
		},
		{
			name: "question with 10 options (list, max)",
			cmd: types.SendMessageCommand{
				CommandID:      "cmd_5",
				ConversationID: "conv_1",
				UserID:         "user_1",
				Platform:       types.PlatformWhatsApp,
				Message: types.MessageContent{
					Type:         types.MessageTypeQuestion,
					QuestionText: stringPtr("Select a number:"),
					Options: []types.Option{
						{Value: json.RawMessage(`"1"`), Label: "One"},
						{Value: json.RawMessage(`"2"`), Label: "Two"},
						{Value: json.RawMessage(`"3"`), Label: "Three"},
						{Value: json.RawMessage(`"4"`), Label: "Four"},
						{Value: json.RawMessage(`"5"`), Label: "Five"},
						{Value: json.RawMessage(`"6"`), Label: "Six"},
						{Value: json.RawMessage(`"7"`), Label: "Seven"},
						{Value: json.RawMessage(`"8"`), Label: "Eight"},
						{Value: json.RawMessage(`"9"`), Label: "Nine"},
						{Value: json.RawMessage(`"10"`), Label: "Ten"},
					},
				},
			},
			want: types.WhatsAppMessage{
				Type: "interactive",
				Interactive: &types.WhatsAppInteractive{
					Type: "list",
					Body: types.WhatsAppText{
						Text: "Select a number:",
					},
					Action: types.WhatsAppAction{
						Button: "Choose",
						Sections: []types.WhatsAppSection{
							{
								Rows: []types.WhatsAppRow{
									{ID: "1", Title: "One"},
									{ID: "2", Title: "Two"},
									{ID: "3", Title: "Three"},
									{ID: "4", Title: "Four"},
									{ID: "5", Title: "Five"},
									{ID: "6", Title: "Six"},
									{ID: "7", Title: "Seven"},
									{ID: "8", Title: "Eight"},
									{ID: "9", Title: "Nine"},
									{ID: "10", Title: "Ten"},
								},
							},
						},
					},
				},
			},
			wantErr: false,
		},
		{
			name: "question with 11 options (too many)",
			cmd: types.SendMessageCommand{
				CommandID:      "cmd_6",
				ConversationID: "conv_1",
				UserID:         "user_1",
				Platform:       types.PlatformWhatsApp,
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
					},
				},
			},
			wantErr: true,
		},
		{
			name: "image with caption",
			cmd: types.SendMessageCommand{
				CommandID:      "cmd_7",
				ConversationID: "conv_1",
				UserID:         "user_1",
				Platform:       types.PlatformWhatsApp,
				Message: types.MessageContent{
					Type:      types.MessageTypeMedia,
					MediaType: mediaTypePtr(types.MediaTypeImage),
					MediaURL:  stringPtr("https://example.com/image.jpg"),
					Caption:   stringPtr("Check out this image!"),
				},
			},
			want: types.WhatsAppMessage{
				Type: "image",
				Image: &types.WhatsAppMedia{
					Link:    "https://example.com/image.jpg",
					Caption: "Check out this image!",
				},
			},
			wantErr: false,
		},
		{
			name: "video message",
			cmd: types.SendMessageCommand{
				CommandID:      "cmd_8",
				ConversationID: "conv_1",
				UserID:         "user_1",
				Platform:       types.PlatformWhatsApp,
				Message: types.MessageContent{
					Type:      types.MessageTypeMedia,
					MediaType: mediaTypePtr(types.MediaTypeVideo),
					MediaURL:  stringPtr("https://example.com/video.mp4"),
				},
			},
			want: types.WhatsAppMessage{
				Type: "video",
				Video: &types.WhatsAppMedia{
					Link: "https://example.com/video.mp4",
				},
			},
			wantErr: false,
		},
		{
			name: "audio message",
			cmd: types.SendMessageCommand{
				CommandID:      "cmd_9",
				ConversationID: "conv_1",
				UserID:         "user_1",
				Platform:       types.PlatformWhatsApp,
				Message: types.MessageContent{
					Type:      types.MessageTypeMedia,
					MediaType: mediaTypePtr(types.MediaTypeAudio),
					MediaURL:  stringPtr("https://example.com/audio.mp3"),
				},
			},
			want: types.WhatsAppMessage{
				Type: "audio",
				Audio: &types.WhatsAppMedia{
					Link: "https://example.com/audio.mp3",
				},
			},
			wantErr: false,
		},
		{
			name: "document message",
			cmd: types.SendMessageCommand{
				CommandID:      "cmd_10",
				ConversationID: "conv_1",
				UserID:         "user_1",
				Platform:       types.PlatformWhatsApp,
				Message: types.MessageContent{
					Type:      types.MessageTypeMedia,
					MediaType: mediaTypePtr(types.MediaTypeFile),
					MediaURL:  stringPtr("https://example.com/document.pdf"),
				},
			},
			want: types.WhatsAppMessage{
				Type: "document",
				Document: &types.WhatsAppMedia{
					Link: "https://example.com/document.pdf",
				},
			},
			wantErr: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := TranslateToWhatsApp(tt.cmd)
			if (err != nil) != tt.wantErr {
				t.Errorf("TranslateToWhatsApp() error = %v, wantErr %v", err, tt.wantErr)
				return
			}
			if !tt.wantErr {
				gotJSON, _ := json.Marshal(got)
				wantJSON, _ := json.Marshal(tt.want)
				if string(gotJSON) != string(wantJSON) {
					t.Errorf("TranslateToWhatsApp() = %s, want %s", gotJSON, wantJSON)
				}
			}
		})
	}
}
