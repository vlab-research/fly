# Redis StateStore Migration

The StateStore has been migrated from `cacheman` (in-memory cache) to Redis for better persistence and scalability.

## Environment Variables

Configure Redis connection using these environment variables:

```bash
# Redis connection settings
REDIS_HOST=localhost          # Redis server host (default: localhost)
REDIS_PORT=6379              # Redis server port (default: 6379)
REDIS_PASSWORD=your_password  # Redis password (optional)
REDIS_DB=0                   # Redis database number (default: 0)

# StateStore specific settings
STATE_STORE_LIMIT=1000       # Limit for state store events (optional)
```

## Usage

### Basic Usage

```javascript
const { StateStore } = require('./lib/typewheels/statestore')
const Chatbase = require('@vlab-research/chatbase-postgres')

const chatbase = new Chatbase()
const stateStore = new StateStore(chatbase, '24h') // TTL of 24 hours

// Get state for a user
const state = await stateStore.getState('user123', event)

// Update state for a user
await stateStore.updateState('user123', newState)

// Close Redis connection when done
await stateStore.close()
```

### Testing with Mock Redis

For testing, you can inject a mock Redis client:

```javascript
const mockRedis = {
  get: sinon.stub(),
  setex: sinon.stub(),
  disconnect: sinon.stub()
}

const stateStore = new StateStore(mockDb, '1h', mockRedis)
```

### TTL Configuration

TTL uses the `parse-duration` library and supports many formats:

#### Basic Formats:
- `'30s'` - 30 seconds
- `'5m'` - 5 minutes  
- `'2h'` - 2 hours
- `'1d'` - 1 day
- `'1w'` - 1 week

#### Complex Formats:
- `'1h 30m'` - 1 hour and 30 minutes
- `'2 hours 15 minutes'` - 2 hours and 15 minutes
- `'1d 6h 30m'` - 1 day, 6 hours, and 30 minutes

#### Written Formats:
- `'2 hours'` - 2 hours
- `'three days'` - 3 days
- `'1 week'` - 1 week

#### Special Cases:
- `'0s'` - No expiration (state will not expire)

#### Error Handling:
- Invalid TTL formats will throw descriptive errors
- Zero TTL will show a warning but work correctly

## Migration from cacheman

The API remains the same, so no code changes are needed:

```javascript
// Before (cacheman)
const stateStore = new StateStore(db, '24h')

// After (Redis) - same API!
const stateStore = new StateStore(db, '24h')
```

## Benefits

1. **Persistence**: State survives application restarts
2. **Scalability**: Can be shared across multiple application instances
3. **Performance**: Redis is fast and optimized for caching
4. **TTL Support**: Automatic expiration of cached states with flexible duration parsing
5. **Monitoring**: Better visibility into cache usage
6. **Robust TTL Parsing**: Uses battle-tested `parse-duration` library

## Docker Setup

Add Redis to your docker-compose.yml:

```yaml
services:
  redis:
    image: redis:alpine
    ports:
      - "6379:6379"
    volumes:
      - redis_data:/data

volumes:
  redis_data:
```

## Testing

Run the StateStore tests:

```bash
npm run _test -- --grep "StateStore"
```

All existing tests should continue to pass with the new Redis implementation. 