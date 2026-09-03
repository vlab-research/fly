package messageworker

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"unicode/utf8"

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

// TestTranslateToWhatsAppWebview covers the webview -> cta_url path. It is a
// separate table from TestTranslateToWhatsApp because the failure cases assert
// on error identity, not just that an error occurred: an over-long buttonText
// is reported to the researcher via states.error, so the wrong error here is a
// misleading dashboard entry.
func TestTranslateToWhatsAppWebview(t *testing.T) {
	webviewCmd := func(text, metadata string) types.SendMessageCommand {
		return types.SendMessageCommand{
			CommandID:      "cmd_wv",
			ConversationID: "conv_1",
			UserID:         "user_1",
			Platform:       types.PlatformWhatsApp,
			Message: types.MessageContent{
				Type:     types.MessageTypeText,
				Text:     stringPtr(text),
				Metadata: json.RawMessage(metadata),
			},
		}
	}

	cta := func(body, label, url string) types.WhatsAppMessage {
		return types.WhatsAppMessage{
			Type: "interactive",
			Interactive: &types.WhatsAppInteractive{
				Type: "cta_url",
				Body: types.WhatsAppText{Text: body},
				Action: types.WhatsAppAction{
					Name:       "cta_url",
					Parameters: &types.WhatsAppCTAParams{DisplayText: label, URL: url},
				},
			},
		}
	}

	tests := []struct {
		name    string
		cmd     types.SendMessageCommand
		want    types.WhatsAppMessage
		wantErr error
	}{
		{
			name: "renders as cta_url with label and hidden url",
			cmd:  webviewCmd("Take a look!", `{"type":"webview","url":"https://example.com","buttonText":"Visit","ref":"wv_1"}`),
			want: cta("Take a look!", "Visit", "https://example.com"),
		},
		{
			name: "defaults buttonText to View website",
			cmd:  webviewCmd("Watch this", `{"type":"webview","url":"https://example.com/v","ref":"wv_2"}`),
			want: cta("Watch this", "View website", "https://example.com/v"),
		},
		{
			// metadata.extensions drives messenger_extensions on Messenger and
			// has no WhatsApp equivalent; it must not leak into the payload.
			name: "ignores messenger-only extensions flag",
			cmd:  webviewCmd("Hi", `{"type":"webview","url":"https://example.com","buttonText":"Go","extensions":true,"ref":"wv_3"}`),
			want: cta("Hi", "Go", "https://example.com"),
		},
		{
			// Real production shape: every linksniffer-tracked link arrives
			// already absolute, with the click-tracking params the button hides.
			name: "linksniffer tracking url",
			cmd: webviewCmd("Learn more about the HPV vaccine.",
				`{"type":"webview","url":"https://links.vlab.digital/?url=unicef.org%2Fnigeria&id=123&pageid=456","buttonText":"UNICEF Nigeria","keepMoving":true,"ref":"hpv_website"}`),
			want: cta("Learn more about the HPV vaccine.", "UNICEF Nigeria",
				"https://links.vlab.digital/?url=unicef.org%2Fnigeria&id=123&pageid=456"),
		},
		{
			// translate-typeform's makeUrl passes string urls through untouched
			// while defaulting the object form to https, so both spellings of
			// the same link must land on https here. "bit.ly/wazzii" and
			// "www.youtube.com/..." are both live in production.
			name: "defaults a scheme-less url to https",
			cmd:  webviewCmd("Chat to us", `{"type":"webview","url":"bit.ly/wazzii","buttonText":"Chat with Wazzii","ref":"wv_4"}`),
			want: cta("Chat to us", "Chat with Wazzii", "https://bit.ly/wazzii"),
		},
		{
			name: "keeps an explicit http url",
			cmd:  webviewCmd("Old link", `{"type":"webview","url":"http://bit.ly/4535gug","buttonText":"Watch the videos","ref":"wv_5"}`),
			want: cta("Old link", "Watch the videos", "http://bit.ly/4535gug"),
		},
		{
			name: "accepts a label at exactly the limit",
			cmd:  webviewCmd("Hi", `{"type":"webview","url":"https://example.com","buttonText":"12345678901234567890","ref":"wv_6"}`),
			want: cta("Hi", "12345678901234567890", "https://example.com"),
		},
		{
			// The flysmoke smoke-test label, which is 23 characters.
			name:    "rejects an over-long label",
			cmd:     webviewCmd("Testing", `{"type":"webview","url":"https://example.com","buttonText":"▶️ Watch the test video","ref":"movie_webview_prod"}`),
			wantErr: types.ErrWebviewButtonTextTooLong,
		},
		{
			// tel:/mailto:/sms: are expected to go through linksniffer's "p"
			// param, which yields an https URL that redirects.
			name:    "rejects a non-http scheme",
			cmd:     webviewCmd("Call us", `{"type":"webview","url":"tel:+234-0700-220-1122","buttonText":"Call NPHCDA","ref":"wv_7"}`),
			wantErr: types.ErrWebviewURLScheme,
		},
		{
			name:    "rejects a missing url",
			cmd:     webviewCmd("Take a look!", `{"type":"webview","buttonText":"Visit","ref":"wv_8"}`),
			wantErr: types.ErrMissingWebviewURL,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := TranslateToWhatsApp(tt.cmd)

			if tt.wantErr != nil {
				if !errors.Is(err, tt.wantErr) {
					t.Fatalf("TranslateToWhatsApp() error = %v, want %v", err, tt.wantErr)
				}
				// The researcher reads this string in the dashboard, so it has
				// to name the field that needs fixing.
				if ref := getRefFromMetadata(tt.cmd.Message.Metadata); !strings.Contains(err.Error(), ref) {
					t.Errorf("error %q does not name the field ref %q", err, ref)
				}
				return
			}

			if err != nil {
				t.Fatalf("TranslateToWhatsApp() unexpected error = %v", err)
			}
			gotJSON, _ := json.Marshal(got)
			wantJSON, _ := json.Marshal(tt.want)
			if string(gotJSON) != string(wantJSON) {
				t.Errorf("TranslateToWhatsApp() = %s, want %s", gotJSON, wantJSON)
			}
		})
	}
}

// TestTranslateWhatsAppListDescriptions covers the list row description, which
// carries the full option text on WhatsApp.
//
// It is separate from TestTranslateToWhatsApp because the cases assert on the
// description specifically: on Messenger a bare "A" quick reply sits beside a
// visible question body, but on WhatsApp the choice list opens OVER the
// conversation, so a row that says only "A" leaves the respondent nothing to
// choose on. These assert that the text is recovered from the body, clipped at
// a word boundary, and suppressed when it would merely repeat the title.
func TestTranslateWhatsAppListDescriptions(t *testing.T) {
	listCmd := func(questionText string, opts []types.Option) types.SendMessageCommand {
		return types.SendMessageCommand{
			CommandID:      "cmd_desc",
			ConversationID: "conv_1",
			UserID:         "user_1",
			Platform:       types.PlatformWhatsApp,
			Message: types.MessageContent{
				Type:         types.MessageTypeQuestion,
				QuestionText: stringPtr(questionText),
				Options:      opts,
			},
		}
	}
	coded := []types.Option{
		{Value: json.RawMessage(`"A"`), Label: "A"},
		{Value: json.RawMessage(`"B"`), Label: "B"},
		{Value: json.RawMessage(`"C"`), Label: "C"},
		{Value: json.RawMessage(`"D"`), Label: "D"},
	}

	tests := []struct {
		name     string
		cmd      types.SendMessageCommand
		wantDesc []string
	}{
		{
			// The real shape upload-typeform produces: bare codes as labels,
			// full option text appended to the title.
			name: "recovers option text from the labelled question body",
			cmd: listCmd("Where did you get food from outside the home?\n\n"+
				"A. Cafe or bakery\nB. Fast food\nC. Street vendor\nD. Canteen", coded),
			wantDesc: []string{"Cafe or bakery", "Fast food", "Street vendor", "Canteen"},
		},
		{
			// 79 chars: clipped at a word boundary with an ellipsis, never
			// mid-word, and the result stays inside the 72-char cap.
			name: "clips an over-long description at a word boundary",
			cmd: listCmd("Where?\n\nA. Restaurant / sit-down restaurant / workplace, "+
				"school or institutional cafeteria\nB. Cafe\nC. Stall\nD. Home", coded),
			wantDesc: []string{
				"Restaurant / sit-down restaurant / workplace, school or institutional…",
				"Cafe", "Stall", "Home",
			},
		},
		{
			// An unlabelled question already carries its text in the label, so a
			// description would render the same string twice.
			name: "omits descriptions for an unlabelled question",
			cmd: listCmd("What is your gender?", []types.Option{
				{Value: json.RawMessage(`"Male"`), Label: "Male"},
				{Value: json.RawMessage(`"Female"`), Label: "Female"},
				{Value: json.RawMessage(`"Other"`), Label: "Other"},
				{Value: json.RawMessage(`"Prefer not to say"`), Label: "Prefer not to say"},
			}),
			wantDesc: []string{"", "", "", ""},
		},
		{
			// An explicit description from the form wins over the derived one.
			name: "prefers an explicit description",
			cmd: listCmd("Where?\n\nA. Cafe\nB. Fast food\nC. Stall\nD. Canteen",
				[]types.Option{
					{Value: json.RawMessage(`"A"`), Label: "A", Description: stringPtr("Authored")},
					{Value: json.RawMessage(`"B"`), Label: "B"},
					{Value: json.RawMessage(`"C"`), Label: "C"},
					{Value: json.RawMessage(`"D"`), Label: "D"},
				}),
			wantDesc: []string{"Authored", "Fast food", "Stall", "Canteen"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := TranslateToWhatsApp(tt.cmd)
			if err != nil {
				t.Fatalf("TranslateToWhatsApp() error = %v", err)
			}
			rows := got.Interactive.Action.Sections[0].Rows
			if len(rows) != len(tt.wantDesc) {
				t.Fatalf("got %d rows, want %d", len(rows), len(tt.wantDesc))
			}
			for i, want := range tt.wantDesc {
				if rows[i].Description != want {
					t.Errorf("row %d description = %q, want %q", i, rows[i].Description, want)
				}
				if n := utf8.RuneCountInString(rows[i].Description); n > types.WhatsAppRowDescriptionMaxChars {
					t.Errorf("row %d description is %d chars, over the %d cap",
						i, n, types.WhatsAppRowDescriptionMaxChars)
				}
			}
		})
	}
}

// TestTranslateWhatsAppListButton covers the label on the button that opens the
// choice sheet. It is respondent-facing, so a Spanish survey showing "Choose"
// reads as an untranslated survey; the string comes from the form's Messages
// (label.button.list) via replybot, carried here as metadata.
func TestTranslateWhatsAppListButton(t *testing.T) {
	cmd := func(metadata string) types.SendMessageCommand {
		c := types.SendMessageCommand{
			CommandID:      "cmd_btn",
			ConversationID: "conv_1",
			UserID:         "user_1",
			Platform:       types.PlatformWhatsApp,
			Message: types.MessageContent{
				Type:         types.MessageTypeQuestion,
				QuestionText: stringPtr("¿Dónde conseguiste comida?\n\nA. Cafetería\nB. Puesto\nC. Casa\nD. Otro"),
				Options: []types.Option{
					{Value: json.RawMessage(`"A"`), Label: "A"},
					{Value: json.RawMessage(`"B"`), Label: "B"},
					{Value: json.RawMessage(`"C"`), Label: "C"},
					{Value: json.RawMessage(`"D"`), Label: "D"},
				},
			},
		}
		if metadata != "" {
			c.Message.Metadata = json.RawMessage(metadata)
		}
		return c
	}

	tests := []struct {
		name string
		cmd  types.SendMessageCommand
		want string
	}{
		{
			// No Messages entry: existing forms keep today's behaviour exactly.
			name: "defaults to Choose when unset",
			cmd:  cmd(`{"ref":"q21"}`),
			want: "Choose",
		},
		{
			name: "uses the form's localised label",
			cmd:  cmd(`{"ref":"q21","listButtonText":"Elegir"}`),
			want: "Elegir",
		},
		{
			// An empty string is not a translation -- fall back rather than
			// sending a blank button, which WhatsApp rejects.
			name: "falls back when the label is empty",
			cmd:  cmd(`{"ref":"q21","listButtonText":""}`),
			want: "Choose",
		},
		{
			name: "defaults when there is no metadata at all",
			cmd:  cmd(""),
			want: "Choose",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := TranslateToWhatsApp(tt.cmd)
			if err != nil {
				t.Fatalf("TranslateToWhatsApp() error = %v", err)
			}
			if got.Interactive.Action.Button != tt.want {
				t.Errorf("list button = %q, want %q", got.Interactive.Action.Button, tt.want)
			}
		})
	}
}
