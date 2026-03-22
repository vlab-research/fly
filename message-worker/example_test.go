package messageworker_test

import (
	"encoding/json"
	"fmt"
	"log"

	messageworker "github.com/vlab-research/fly/message-worker"
	"github.com/vlab-research/fly/message-worker/types"
)

// Helper function
func stringPtr(s string) *string {
	return &s
}

func mediaTypePtr(m types.MediaType) *types.MediaType {
	return &m
}

// Example: Basic text message translation
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

	// Output the translated message
	jsonBytes, _ := json.MarshalIndent(msg, "", "  ")
	fmt.Println(string(jsonBytes))

	// Output:
	// {
	//   "text": "Hello, welcome to our survey!"
	// }
}

// Example: Question with options for Messenger
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
				{Value: "male", Label: "Male"},
				{Value: "female", Label: "Female"},
				{Value: "other", Label: "Other"},
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

// Example: WhatsApp question with buttons (≤3 options)
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
				{Value: "yes", Label: "Yes, I agree"},
				{Value: "no", Label: "No, thanks"},
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

// Example: WhatsApp question with list (4-10 options)
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
				{Value: "18-24", Label: "18-24"},
				{Value: "25-34", Label: "25-34"},
				{Value: "35-44", Label: "35-44"},
				{Value: "45-54", Label: "45-54"},
				{Value: "55+", Label: "55+"},
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

// Example: Image message with caption for WhatsApp
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

// Example: Error handling for too many options
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
				{Value: "13", Label: "Not sure"},
				{Value: "14", Label: "Prefer not to say"}, // 14th option - too many!
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

// Example: Platform switching
func Example_platformSwitching() {
	// Same message content
	messageContent := types.MessageContent{
		Type:         types.MessageTypeQuestion,
		QuestionText: stringPtr("What is your gender?"),
		Options: []types.Option{
			{Value: "male", Label: "Male"},
			{Value: "female", Label: "Female"},
			{Value: "other", Label: "Other"},
		},
	}

	// Translate for Messenger
	messengerCmd := types.SendMessageCommand{
		CommandID:      "cmd_129",
		ConversationID: "conv_456",
		UserID:         "user_789",
		Platform:       types.PlatformMessenger,
		Message:        messageContent,
	}
	messengerMsg, _ := messageworker.TranslateToMessenger(messengerCmd)
	fmt.Printf("Messenger: %d quick_replies\n", len(messengerMsg.QuickReplies))

	// Translate for WhatsApp
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

	// Translate for Instagram
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
