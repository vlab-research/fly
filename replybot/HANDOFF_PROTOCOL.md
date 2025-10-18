# Facebook Messenger Handoff Protocol Feature

## Overview

The handoff protocol feature allows surveys to temporarily hand off conversation control to external Facebook Messenger applications, then seamlessly resume the survey when control is returned. This enables integration with specialized tools like educational assessments, literacy tests, accessibility evaluations, or any custom chatbot functionality.

## Key Concepts

### What is a Handoff?

A handoff occurs when a survey:
1. Reaches a special "handoff" question
2. Transfers conversation control to an external Facebook app
3. Waits for the external app to complete its interaction
4. Receives control back (either automatically or via timeout)
5. Continues the survey from where it left off

### Why Use Handoffs?

Handoffs are useful when you need to:
- Conduct specialized assessments (reading level, comprehension tests)
- Use existing chatbot tools without rebuilding them
- Integrate with external services that have their own conversation flows
- Collect data through interactive modules that exist in other systems
- Provide specialized support or interventions through partner applications

## How to Use Handoffs

### Basic Handoff Question

Add a handoff question to your survey by creating a statement question with a special description:

```yaml
type: handoff
target_app_id: 123456789
timeout_minutes: 30
```

**Parameters:**
- `target_app_id`: The Facebook app ID of the external application (required)
- `timeout_minutes`: How long to wait before taking control back (default: 60)

**Example in Typeform:**
Create a statement question with the description field containing the above YAML, and the survey will hand off to the specified app when this question is reached.

### Advanced Handoff with Custom Wait Conditions

For more control over when the survey resumes, you can specify complex wait conditions:

```json
{
  "type": "handoff",
  "target_app_id": "987654321",
  "wait": {
    "op": "or",
    "vars": [
      {"type": "external", "value": {"type": "handoff_return", "target_app_id": "987654321"}},
      {"type": "timeout", "value": "45m"}
    ]
  },
  "metadata": {
    "survey_context": "literacy_assessment",
    "participant_id": "{{hidden:id}}"
  }
}
```

**Wait Condition Options:**
- `handoff_return`: Resume when external app explicitly returns control
- `timeout`: Resume after specified duration (e.g., "30m", "2h", "1d")
- `op: "or"`: Resume when ANY condition is met
- `op: "and"`: Resume when ALL conditions are met

### Passing Metadata to External Apps

You can include metadata that will be sent to the external app:

```json
{
  "type": "handoff",
  "target_app_id": "555666777",
  "metadata": {
    "participant_age": "{{hidden:age}}",
    "survey_language": "{{hidden:language}}",
    "assessment_type": "reading_comprehension"
  }
}
```

The external app receives this metadata when it gains thread control.

## Receiving Data from External Apps

When external apps return control, they can include metadata that becomes available as hidden fields in your survey.

### How It Works

External apps call Facebook's `pass_thread_control` API with metadata:

```json
{
  "completion_status": "success",
  "assessment_results": {
    "reading_level": 6,
    "comprehension_score": 82
  },
  "recommendations": ["literacy_support", "visual_aids"]
}
```

This metadata is automatically flattened and stored with prefix `e_handover_`:

```javascript
e_handover_completion_status: "success"
e_handover_assessment_results_reading_level: 6
e_handover_assessment_results_comprehension_score: 82
e_handover_recommendations_0: "literacy_support"
e_handover_recommendations_1: "visual_aids"
```

### Using Returned Data in Surveys

Access the flattened metadata in subsequent questions:

**In question text:**
```
Based on your reading level of grade {{hidden:e_handover_assessment_results_reading_level}},
we have prepared appropriate materials for you.
```

**In survey logic:**
```javascript
// Branch based on comprehension score
if ({{hidden:e_handover_assessment_results_comprehension_score}} > 80) {
  // Show advanced content
}
```

**In logic jumps:**
Use the hidden fields in Typeform logic to determine which questions to show based on assessment results.

## Use Cases

### 1. Literacy Assessment Integration

Hand off to an external literacy testing app:

```yaml
type: handoff
target_app_id: 111222333
timeout_minutes: 20
metadata:
  assessment_type: literacy
  grade_level: adult
```

The literacy app conducts an interactive reading test, then returns:
- Reading level assessment
- Comprehension scores
- Recommendations for content difficulty

Survey continues with appropriate question complexity based on results.

### 2. Multilingual Support Assessment

Hand off to language proficiency evaluation:

```yaml
type: handoff
target_app_id: 444555666
timeout_minutes: 15
metadata:
  languages_offered: ["english", "spanish", "portuguese"]
```

Language app assesses participant's preferred language and proficiency, returns:
- Preferred language
- Proficiency level
- Need for translation support

Survey continues in appropriate language with suitable complexity.

### 3. Accessibility Needs Evaluation

Hand off to accessibility assessment tool:

```yaml
type: handoff
target_app_id: 777888999
timeout_minutes: 10
metadata:
  survey_context: accessibility_check
```

Accessibility app determines participant needs, returns:
- Vision support requirements
- Audio support needs
- Reading assistance preferences

Survey adapts format based on identified needs.

### 4. Interactive Educational Module

Hand off to external educational content:

```yaml
type: handoff
target_app_id: 123123123
timeout_minutes: 45
metadata:
  module_type: health_education
  topic: vaccination_info
```

Educational module provides interactive learning experience, returns:
- Completion status
- Quiz scores
- Topics needing reinforcement

Survey asks follow-up questions based on learning outcomes.

## Technical Details

### State Management

During handoff, the survey user is in `WAIT_EXTERNAL_EVENT` state. All survey state is preserved, including:
- Current form and question position
- All collected responses (qa array)
- User metadata
- Survey metadata

When control returns, the survey resumes from the next question after the handoff.

### Timeout Behavior

If the external app never returns control:
1. Timeout event is generated after configured duration
2. Replybot automatically calls `take_thread_control` to reclaim conversation
3. Survey continues normally

This ensures surveys never get permanently stuck.

### Security

Handoff return events are validated:
- Only events from the expected `target_app_id` are processed
- Events from unexpected apps are ignored
- Control must be explicitly passed to our app ID

### Metadata Flattening

Complex nested metadata is automatically flattened:
- Nested objects: `{user: {age: 25}}` → `e_handover_user_age: 25`
- Arrays: `{tags: ["a", "b"]}` → `e_handover_tags_0: "a"`, `e_handover_tags_1: "b"`
- All data types preserved: strings, numbers, booleans, null

## External App Requirements

For an app to work with handoff protocol, it needs to:

1. **Be configured as Secondary Receiver** in Facebook Page settings
2. **Receive thread control** when survey hands off
3. **Return control** by calling Facebook's `pass_thread_control` API:
   ```javascript
   POST https://graph.facebook.com/v18.0/me/pass_thread_control
   {
     "recipient": {"id": "user_psid"},
     "target_app_id": "our_app_id",
     "metadata": "{\"result\": \"data\"}"
   }
   ```

That's it! No special API integration or webhooks required on the external app side.

## Configuration

### Facebook App Setup

1. **Set replybot app as Primary Receiver:**
   - Go to Page Settings → Messenger Platform
   - Set your replybot app as Primary Receiver

2. **Add webhook subscription:**
   - In Facebook App dashboard, add `messaging_handovers` to webhook subscriptions
   - Botserver already handles these events

3. **Configure external apps as Secondary Receivers:**
   - External apps must be added to the page
   - They will automatically be Secondary Receivers

### Environment Variables

Required environment variable:
```bash
FACEBOOK_APP_ID=your_replybot_app_id
```

This is used to validate that control is returned to the correct app.

## Troubleshooting

### Survey doesn't resume after handoff

**Check:**
- Is `target_app_id` correct?
- Is external app returning control to correct app ID?
- Is timeout sufficient for external app to complete?
- Check botserver logs for handover webhook events

### Metadata not appearing in survey

**Check:**
- Is metadata properly JSON-formatted when external app calls `pass_thread_control`?
- Are you using correct field names with `e_handover_` prefix?
- Check replybot logs to see if external event was processed

### External app never gets control

**Check:**
- Is external app configured as Secondary Receiver on the page?
- Is `target_app_id` the correct Facebook app ID?
- Check replybot logs for `passThreadControl` API call results

## Examples

### Complete Example: Reading Assessment Flow

**Survey Structure:**
1. Welcome questions (demographics)
2. Handoff to literacy assessment app
3. Resume with personalized content based on results
4. Main survey questions at appropriate reading level
5. Thank you message

**Handoff Question:**
```json
{
  "type": "handoff",
  "target_app_id": "999888777",
  "timeout_minutes": 20,
  "wait": {
    "op": "or",
    "vars": [
      {"type": "external", "value": {"type": "handoff_return", "target_app_id": "999888777"}},
      {"type": "timeout", "value": "20m"}
    ]
  },
  "metadata": {
    "participant_id": "{{hidden:id}}",
    "age_group": "{{hidden:age_group}}",
    "assessment_type": "reading_comprehension"
  }
}
```

**Next Question (after handoff):**
```
Title: "Thank you for completing the assessment!"
Text: "Based on your reading level of grade {{hidden:e_handover_assessment_results_reading_level}},
we've prepared questions that match your comprehension level."
```

**Logic Jump:**
- If `{{hidden:e_handover_assessment_results_reading_level}} < 6`: Jump to simplified questions
- If `{{hidden:e_handover_assessment_results_reading_level}} >= 6`: Continue to standard questions

**Result:** Survey adapts to participant's demonstrated literacy level, improving response quality and completion rates.

## Best Practices

1. **Always set reasonable timeouts** - External apps may fail, ensure survey can continue
2. **Provide clear transition messages** - Tell users what's happening during handoff
3. **Test with real users** - Handoff introduces external dependencies, test thoroughly
4. **Use metadata for personalization** - Leverage returned data to improve survey experience
5. **Have fallback logic** - Design surveys to work even if handoff fails or times out
6. **Keep external apps focused** - Short, single-purpose interactions work best
7. **Document metadata contracts** - Clearly specify what data external apps should return

## Future Enhancements

Potential future additions to the handoff protocol:

- **User message detection**: Resume when user sends any message during handoff
- **Multi-step handoffs**: Chain multiple external apps in sequence
- **Conditional handoffs**: Only hand off based on previous answers
- **Handoff analytics**: Track success rates, completion times, metadata patterns

## Related Documentation

- **Implementation Specification**: See `HANDOFF_PROTOCOL_IMPLEMENTATION.md` for technical implementation details
- **Wait Logic**: See `lib/typewheels/waiting.js` for wait condition syntax
- **External Events**: See machine tests for external event processing examples
- **Facebook Handover Protocol**: https://developers.facebook.com/docs/messenger-platform/reference/handover-protocol/

## Support

For issues or questions about handoff protocol:
- Check botserver and replybot logs for debugging information
- Verify Facebook app configuration and permissions
- Review external app's `pass_thread_control` implementation
- Test with simple timeout-only handoff first to isolate issues
