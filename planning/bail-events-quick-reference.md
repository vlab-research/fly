# Bail Events Dashboard - Quick Reference Guide

## File Locations

| Component | File Path | Lines | Purpose |
|-----------|-----------|-------|---------|
| Events Table | `/dashboard-client/src/containers/BailSystems/BailEvents.js` | 1-119 | Main events list view |
| Systems List | `/dashboard-client/src/containers/BailSystems/BailSystems.js` | 1-203 | Shows "View History" button for events |
| Routes | `/dashboard-client/src/root.js` | 38-41 | Bail routes registration |
| API Client | `/dashboard-client/src/services/api/fetcher.js` | 1-41 | HTTP request handler |
| Detail Pattern | `/dashboard-client/src/containers/StatesExplorer/StateDetail.js` | 1-298 | Reference for detail view |

## Key APIs

### Get Events for a Bail
```
GET /api/v1/users/{userId}/bails/{bailId}/events
Authorization: Bearer {token}

Response 200:
{
  "events": [
    {
      "id": "uuid",
      "timestamp": "ISO-8601",
      "event_type": "execution|error",
      "bail_name": "string",
      "users_matched": number,
      "users_bailed": number,
      "execution_results": { "user_ids": [...] },  // EXECUTION ONLY
      "error": { ... },                            // ERROR ONLY
      "definition_snapshot": { ... }               // FULL DEFINITION AT EXECUTION TIME
    }
  ]
}
```

### Get User ID
```
POST /api/v1/users
Content-Type: application/json
Body: {}

Response: { "id": "user-uuid", ... }
```

## Current Table Columns (BailEvents.js:53-90)

1. **Timestamp** - Date formatted to locale string, sorted descending
2. **Event Type** - Tag: green="execution", red="error"
3. **Users Matched** - Count of users matching query
4. **Users Bailed** - Count of successful bailouts
5. **Error** - Shows error.message if present, red text

**Missing:** execution_results.user_ids (need to add)

## Component State (BailEvents.js:13-15)

```javascript
const [events, setEvents] = useState(null);          // Array from API
const [bail, setBail] = useState(null);               // Bail metadata
const [loading, setLoading] = useState(true);         // Loading state
```

**Add for modal:**
```javascript
const [selectedEvent, setSelectedEvent] = useState(null);
```

## Navigation Flow

```
/bails (BailSystems list)
  └── HistoryOutlined button
      └── /bails/{bailId}/events (BailEvents)
          └── Back button → /bails
```

## Implementation Steps (Modal Approach)

### 1. Add State Hook
Location: After line 15
```javascript
const [selectedEvent, setSelectedEvent] = useState(null);
```

### 2. Add Details Column
Location: After line 90 in columns array
```javascript
{
  title: 'Details',
  key: 'details',
  width: 100,
  render: (_, record) => (
    <Button type="link" size="small" onClick={() => setSelectedEvent(record)}>
      View
    </Button>
  ),
}
```

### 3. Add Modal Component
Location: After Table element (after line 112), before closing </Content>
```jsx
<Modal visible={selectedEvent !== null} onCancel={() => setSelectedEvent(null)}>
  {selectedEvent && (
    <>
      <Descriptions bordered>
        <Descriptions.Item label="Timestamp">
          {new Date(selectedEvent.timestamp).toLocaleString()}
        </Descriptions.Item>
        <Descriptions.Item label="Event Type">
          <Tag color={selectedEvent.event_type === 'execution' ? 'green' : 'red'}>
            {selectedEvent.event_type}
          </Tag>
        </Descriptions.Item>
        {/* ... more fields ... */}
      </Descriptions>

      {selectedEvent.execution_results?.user_ids && (
        <Card title="Bailed Users">
          {selectedEvent.execution_results.user_ids.map(uid => (
            <div key={uid}>{uid}</div>
          ))}
        </Card>
      )}
    </>
  )}
</Modal>
```

### 4. Update Imports (Line 3)
Add: `Modal, Descriptions, Collapse`
```javascript
import { Table, Layout, Tag, Button, Card, message, Modal, Descriptions, Collapse } from 'antd';
```

## What execution_results Contains

From API documentation (bail-systems.md:477):
- **Field:** `execution_results` (on BailEvent object)
- **Type:** `{ user_ids: string[] }` or `null`
- **When present:** Only for `event_type === 'execution'` (successful executions)
- **When null:** `event_type === 'error'` (failed executions)
- **Usage:** Shows which specific users were bailed (redirected) in this execution

Example:
```json
{
  "execution_results": {
    "user_ids": [
      "user_123",
      "user_456",
      "user_789"
    ]
  }
}
```

## Error Structure

From API - when event_type === 'error':
```json
{
  "error": {
    "message": "string",
    "code": "string",
    "details": { /* object */ }
  }
}
```

## Testing Checklist

- [ ] Modal opens on "View" button click
- [ ] execution_results.user_ids displays as list
- [ ] Large user lists scroll properly (max-height: 300px)
- [ ] Error events show error details instead of user list
- [ ] Modal closes on Cancel or background click
- [ ] Timestamp formats correctly per user's locale
- [ ] No errors in browser console

## Pattern Differences

| Aspect | BailEvents (Modal) | StateDetail (Full Page) |
|--------|-------------------|------------------------|
| Component | Single file update | New component |
| Navigation | None (modal) | New route /bails/.../events/{id} |
| Complexity | Low (~60 min) | High (requires routing) |
| Use Case | Simple event details | Complex nested data |

## Future Enhancements

1. Export user IDs to CSV
2. Copy all user IDs to clipboard
3. Search/filter within user list
4. Comparison of definition_snapshot vs current definition
5. Retry failed execution from modal
6. Activity timeline with visual indicators

## Dependencies

All required Ant Design components already imported or available:
- `Modal` - dialog box
- `Descriptions` - key-value display
- `Card` - content container
- `Tag` - colored labels
- `Table` - already imported
- `Button` - already imported

No new packages needed.
