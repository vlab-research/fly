package messageworker_test

import (
	"encoding/json"
	"fmt"
	"log"

	messageworker "github.com/vlab-research/fly/message-worker"
	"github.com/vlab-research/fly/message-worker/types"
)

func stringPtr(s string) *string {
	return &s
}

func mediaTypePtr(m types.MediaType) *types.MediaType {
	return &m
}

func ExampleTranslateToMessenger_text() {
	cmd := types.SendMessageCommand{
		CommandID:      "cmd_123",
		ConversationID: "conv_456",
		UserID:         "user_789",
		Platform:       types.PlatformMessenger,
		Message: types.MessageContent{
			Type: types.MessageTypeText,
			Text: stringPtr("Hello, welcome to our survey!"),
		},
	}

	msg, err := messageworker.TranslateToMessenger(cmd)
	if err != nil {
		log.Fatal(err)
	}

	jsonBytes, _ := json.MarshalIndent(msg, "", "  ")
	fmt.Println(string(jsonBytes))

	// Output:
	// {
	//   "text": "Hello, welcome to our survey!"
	// }
}

func ExampleTranslateToMessenger_question() {
	cmd := types.SendMessageCommand{
		CommandID:      "cmd_124",
		ConversationID: "conv_456",
		UserID:         "user_789",
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
	}

	msg, err := messageworker.TranslateToMessenger(cmd)
	if err != nil {
		log.Fatal(err)
	}

	jsonBytes, _ := json.MarshalIndent(msg, "", "  ")
	fmt.Println(string(jsonBytes))

	// Output:
	// {
	//   "text": "What is your gender?",
	//   "quick_replies": [
	//     {
	//       "content_type": "text",
	//       "title": "Male",
	//       "payload": "male"
	//     },
	//     {
	//       "content_type": "text",
	//       "title": "Female",
	//       "payload": "female"
	//     },
	//     {
	//       "content_type": "text",
	//       "title": "Other",
	//       "payload": "other"
	//     }
	//   ]
	// }
}

func ExampleTranslateToWhatsApp_buttons() {
	cmd := types.SendMessageCommand{
		CommandID:      "cmd_125",
		ConversationID: "conv_456",
		UserID:         "user_789",
		Platform:       types.PlatformWhatsApp,
		Message: types.MessageContent{
			Type:         types.MessageTypeQuestion,
			QuestionText: stringPtr("Do you agree to participate?"),
			Options: []types.Option{
				{Value: json.RawMessage(`"yes"`), Label: "Yes, I agree"},
				{Value: json.RawMessage(`"no"`), Label: "No, thanks"},
			},
		},
	}

	msg, err := messageworker.TranslateToWhatsApp(cmd)
	if err != nil {
		log.Fatal(err)
	}

	jsonBytes, _ := json.MarshalIndent(msg, "", "  ")
	fmt.Println(string(jsonBytes))

	// Output:
	// {
	//   "type": "interactive",
	//   "interactive": {
	//     "type": "button",
	//     "body": {
	//       "text": "Do you agree to participate?"
	//     },
	//     "action": {
	//       "buttons": [
	//         {
	//           "type": "reply",
	//           "reply": {
	//             "id": "yes",
	//             "title": "Yes, I agree"
	//           }
	//         },
	//         {
	//           "type": "reply",
	//           "reply": {
	//             "id": "no",
	//             "title": "No, thanks"
	//           }
	//         }
	//       ]
	//     }
	//   }
	// }
}

func ExampleTranslateToWhatsApp_list() {
	cmd := types.SendMessageCommand{
		CommandID:      "cmd_126",
		ConversationID: "conv_456",
		UserID:         "user_789",
		Platform:       types.PlatformWhatsApp,
		Message: types.MessageContent{
			Type:         types.MessageTypeQuestion,
			QuestionText: stringPtr("What is your age range?"),
			Options: []types.Option{
				{Value: json.RawMessage(`"18-24"`), Label: "18-24"},
				{Value: json.RawMessage(`"25-34"`), Label: "25-34"},
				{Value: json.RawMessage(`"35-44"`), Label: "35-44"},
				{Value: json.RawMessage(`"45-54"`), Label: "45-54"},
				{Value: json.RawMessage(`"55+"`), Label: "55+"},
			},
		},
	}

	msg, err := messageworker.TranslateToWhatsApp(cmd)
	if err != nil {
		log.Fatal(err)
	}

	jsonBytes, _ := json.MarshalIndent(msg, "", "  ")
	fmt.Println(string(jsonBytes))

	// Output:
	// {
	//   "type": "interactive",
	//   "interactive": {
	//     "type": "list",
	//     "body": {
	//       "text": "What is your age range?"
	//     },
	//     "action": {
	//       "button": "Choose",
	//       "sections": [
	//         {
	//           "rows": [
	//             {
	//               "id": "18-24",
	//               "title": "18-24"
	//             },
	//             {
	//               "id": "25-34",
	//               "title": "25-34"
	//             },
	//             {
	//               "id": "35-44",
	//               "title": "35-44"
	//             },
	//             {
	//               "id": "45-54",
	//               "title": "45-54"
	//             },
	//             {
	//               "id": "55+",
	//               "title": "55+"
	//             }
	//           ]
	//         }
	//       ]
	//     }
	//   }
	// }
}

func ExampleTranslateToWhatsApp_image() {
	cmd := types.SendMessageCommand{
		CommandID:      "cmd_127",
		ConversationID: "conv_456",
		UserID:         "user_789",
		Platform:       types.PlatformWhatsApp,
		Message: types.MessageContent{
			Type:      types.MessageTypeMedia,
			MediaType: mediaTypePtr(types.MediaTypeImage),
			MediaURL:  stringPtr("https://example.com/survey-info.jpg"),
			Caption:   stringPtr("Please review this information before proceeding."),
		},
	}

	msg, err := messageworker.TranslateToWhatsApp(cmd)
	if err != nil {
		log.Fatal(err)
	}

	jsonBytes, _ := json.MarshalIndent(msg, "", "  ")
	fmt.Println(string(jsonBytes))

	// Output:
	// {
	//   "type": "image",
	//   "image": {
	//     "link": "https://example.com/survey-info.jpg",
	//     "caption": "Please review this information before proceeding."
	//   }
	// }
}

func ExampleTranslateToMessenger_tooManyOptions() {
	cmd := types.SendMessageCommand{
		CommandID:      "cmd_128",
		ConversationID: "conv_456",
		UserID:         "user_789",
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
				{Value: json.RawMessage(`"13"`), Label: "Not sure"},
				{Value: json.RawMessage(`"14"`), Label: "Prefer not to say"},
			},
		},
	}

	_, err := messageworker.TranslateToMessenger(cmd)
	if err != nil {
		fmt.Printf("Error: %v\n", err)
	}

	// Output:
	// Error: too many options for platform: Messenger supports max 13 quick replies, got 14
}

func Example_platformSwitching() {
	messageContent := types.MessageContent{
		Type:         types.MessageTypeQuestion,
		QuestionText: stringPtr("What is your gender?"),
		Options: []types.Option{
			{Value: json.RawMessage(`"male"`), Label: "Male"},
			{Value: json.RawMessage(`"female"`), Label: "Female"},
			{Value: json.RawMessage(`"other"`), Label: "Other"},
		},
	}

	messengerCmd := types.SendMessageCommand{
		CommandID:      "cmd_129",
		ConversationID: "conv_456",
		UserID:         "user_789",
		Platform:       types.PlatformMessenger,
		Message:        messageContent,
	}
	messengerMsg, _ := messageworker.TranslateToMessenger(messengerCmd)
	fmt.Printf("Messenger: %d quick_replies\n", len(messengerMsg.QuickReplies))

	whatsappCmd := types.SendMessageCommand{
		CommandID:      "cmd_130",
		ConversationID: "conv_456",
		UserID:         "user_789",
		Platform:       types.PlatformWhatsApp,
		Message:        messageContent,
	}
	whatsappMsg, _ := messageworker.TranslateToWhatsApp(whatsappCmd)
	fmt.Printf("WhatsApp: type=%s, %d buttons\n",
		whatsappMsg.Interactive.Type,
		len(whatsappMsg.Interactive.Action.Buttons))

	instagramCmd := types.SendMessageCommand{
		CommandID:      "cmd_131",
		ConversationID: "conv_456",
		UserID:         "user_789",
		Platform:       types.PlatformInstagram,
		Message:        messageContent,
	}
	instagramMsg, _ := messageworker.TranslateToInstagram(instagramCmd)
	fmt.Printf("Instagram: %d quick_replies\n", len(instagramMsg.QuickReplies))

	// Output:
	// Messenger: 3 quick_replies
	// WhatsApp: type=button, 3 buttons
	// Instagram: 3 quick_replies
}
