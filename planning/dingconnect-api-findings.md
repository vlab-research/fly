# DingConnect API - Official Reference Documentation

**Date**: March 1, 2026
**Source**: Official DingConnect API Documentation (GitHub PHP Client & Web API)
**Status**: Complete - Based on Official Sources

---

## Executive Summary

DingConnect is a B2B REST API for mobile top-ups (airtime/data) covering 850+ operators in 150+ countries. The API is versioned (V1), uses JSON for all requests/responses, and supports both instant and asynchronous (webhook) processing modes. Authentication is via API Key or OAuth 2.0.

**Base URL**: `https://api.dingconnect.com/api/V1/`

---

## 1. Authentication

### Method 1: API Key Authentication
- **Header Name**: `X-Api-Key` or `api_key`
- **Format**: Include in HTTP request header
- **Setup**: Generated in Account Settings → Developer tab
- **Usage**: All requests include this header

### Method 2: OAuth 2.0 (Recommended)
- **Flow**: Client Credentials (server-to-server)
- **Token Endpoint**: `https://idp.ding.com/connect/token`
- **Required Parameters**:
  - `client_id`: OAuth client ID
  - `client_secret`: OAuth client secret
- **Authorization Header**: `Authorization: Bearer <token>`
- **Token Management**: Request new token when expired

### Security
- Always use HTTPS
- Keep credentials secure (in environment variables, secrets management)
- Webhook payloads can be optionally encrypted (AES-256-GCM with RSA-OAEP)

---

## 2. API Endpoints Reference

All endpoints return JSON. HTTP method varies by operation.

### 2.1 Product & Catalog Endpoints

#### GET /api/V1/GetProducts
**Purpose**: Retrieve available products matching criteria

**Request Parameters**:
- `countryIsos` (array): Filter by country codes (e.g., ["US", "GB"])
- `benefits` (array): Filter by benefit type (e.g., ["Data", "Voice"])

**Response**: Array of product objects

**Product Object Fields**:
- `sku_code` (string): Unique product identifier - **use in SendTransfer**
- `provider_code` (string): Mobile operator identifier
- `localization_key` (string): Reference for GetProductDescriptions
- `setting_definitions` (array): Name/value pairs for transfer submission
- `maximum` (Price object): Upper pricing limit
- `minimum` (Price object): Lower pricing limit
- `commission_rate` (float): Sales commission percentage
- `processing_mode` (string): "Instant" or "Batch"
- `redemption_mechanism` (string): How customer activates transfer
- `benefits` (array): Types of benefits granted (e.g., ["Data"])
- `validity_period_iso` (string, optional): Product expiration duration
- `uat_number` (string): Test number for validation (no balance deduction)
- `additional_information` (string, optional): Distributor-specific notes
- `default_display_text` (string): Localized product name
- `region_code` (string): Geographic market designation

#### GET /api/V1/GetCountries
**Purpose**: Get list of supported country codes

**Response**: Array of country objects with ISO codes and names

#### GET /api/V1/GetRegions
**Purpose**: Get regional grouping information

**Response**: Regional organization data

#### GET /api/V1/GetProviders
**Purpose**: View available mobile operators

**Response**: Array of provider objects with codes and names

#### GET /api/V1/GetPromotions
**Purpose**: List active promotions and special offers

**Response**: Promotion details and applicable products

---

### 2.2 Transaction Endpoints

#### POST /api/V1/SendTransfer
**Purpose**: Send mobile top-up to recipient

**Request Headers**:
- `Authorization`: Bearer token (OAuth) or X-Api-Key
- `Content-Type`: application/json
- `X-Option` (optional): `DeferTransfer` for webhook callback mode

**Request Body Fields**:
- `sku_code` (string, required): Product SKU from GetProducts
- `send_value` (double, required): Amount to transfer (two decimal precision)
- `send_currency_iso` (string, optional): Currency of send_value; defaults to distributor currency
- `account_number` (string, required): Target account number
- `distributor_ref` (string, required): Unique ID within distributor system
- `settings` (Setting[], optional): Product-specific key-value pairs
- `validate_only` (bool, optional): If true, validates without executing; no balance deduction

**Request Example**:
```json
{
  "sku_code": "US_VERIZON_5GB",
  "send_value": 25.00,
  "send_currency_iso": "USD",
  "account_number": "14155552671",
  "distributor_ref": "TXN20260301_001",
  "validate_only": false
}
```

**Response Fields**:
- `transfer_record` (TransferRecord, optional): Result of SendTransfer call
- `result_code` (int, required): Status indicator
- `error_codes` (Error[], required): Array of error details

**TransferRecord Object**:
- `transfer_id` (TransferId): Both system and customer identifiers
- `sku_code` (string): Product identifier
- `price` (Price): Resulting price of transfer
- `commission_applied` (float): Commission earned
- `started_utc` (DateTime): When processing started
- `completed_utc` (DateTime, optional): When completed
- `processing_state` (string): Current state ("Submitted", "Completed", "Failed")
- `receipt_text` (string, optional): Provider receipt information
- `receipt_params` (map[string,string]): Name/value pairs from receipt
- `account_number` (string): Target account number

**Processing Modes**:
- **Instant Mode** (default): Returns with ProcessingState = "Completed" or "Failed"
- **Deferred Mode** (`X-Option: DeferTransfer` header): Returns with ProcessingState = "Submitted", webhook fires when complete

**Timeout**: 90 seconds - if not completed, response includes `ProviderTimedOut` error

**ValidateOnly Behavior**:
- Only validates syntax and checks balance
- No balance deduction
- No TransferId assigned
- Used for preview/estimation

**Response Example** (Success):
```json
{
  "transfer_record": {
    "transfer_id": "TXN20260301_001",
    "sku_code": "US_VERIZON_5GB",
    "processing_state": "Completed",
    "commission_applied": 5.00,
    "receipt_text": "5GB data bundle sent successfully",
    "account_number": "14155552671"
  },
  "result_code": 1,
  "error_codes": []
}
```

#### POST /api/V1/CancelTransfers
**Purpose**: Cancel previously submitted transfers

**Request Body**:
```json
{
  "cancellation_requests": [
    { "transfer_id": "TXN20260301_001" }
  ]
}
```

**Response**: Updated transfer records with ProcessingState

#### POST /api/V1/ListTransferRecords
**Purpose**: Query transaction history and status

**Request Parameters**:
- `skip` (int): Pagination offset
- `take` (int): Number of records (max 100 recommended)
- Query filters for specific transfers

**Response**: Array of transfer record objects with:
- `transfer_id`: Unique transaction ID
- `processing_state`: "Completed", "Failed", "Submitted", "Cancelled", etc.
- `account_number`: Recipient account
- `send_value`: Amount sent
- `receive_value`: Amount received
- `sku_code`: Product SKU
- Timestamp information

---

### 2.3 Account & Balance Endpoints

#### GET /api/V1/GetBalance
**Purpose**: Retrieve current agent account balance

**Request Parameters**: None

**Response Fields**:
- `result_code` (int): Status code
- `balance` (float): Current account balance
- `currency_iso` (string): Currency code (e.g., "USD")
- `error_codes` (Error[]): Array of errors if applicable

**Response Example**:
```json
{
  "result_code": 1,
  "balance": 1500.50,
  "currency_iso": "USD",
  "error_codes": []
}
```

**Important**: Balance includes commission increments but won't reflect processing transfers

#### GET /api/V1/GetAccountLookup
**Purpose**: Get providers and product info for specific account number

**Parameters**: Account number/identifier

**Response**: Available providers and products for that account

---

### 2.4 Pricing Endpoints

#### POST /api/V1/EstimatePrices
**Purpose**: Get price estimates for send/receive values

**Request Body**:
```json
{
  "sku_code": "US_VERIZON_5GB",
  "send_value": 25.00
}
```
Or use `receive_value` instead of `send_value`

**Response**:
- `send_value`: Amount needed in operator currency
- `receive_value`: Amount received by customer
- `markup_percentage`: Markup percentage
- `result_code`: Status code
- `error_codes`: Array of errors

---

### 2.5 Status & Reference Endpoints

#### GET /api/V1/GetProviderStatus
**Purpose**: Check real-time availability of product providers

**Parameters**: Optional filter for specific provider codes

**Response**: Provider status (online/offline/degraded)

#### GET /api/V1/GetErrorCodeDescriptions
**Purpose**: Get human-readable descriptions for error codes

**Request Parameters**: Array of error code strings

**Response**: Mapping of error codes to descriptions

**Important**: Error messages are for agents, not end users

#### GET /api/V1/GetProductDescriptions
**Purpose**: Get localized descriptions for products

**Response**: Product display names and descriptions

#### GET /api/V1/GetPromotionDescriptions
**Purpose**: Get localized promotion descriptions

**Response**: Promotion display information

---

## 3. Response Structure & Status Codes

### Standard Response Format
All responses include:
```json
{
  "result_code": integer,
  "error_codes": [array of string],
  "[endpoint-specific fields]": "..."
}
```

### ResultCode Values

**Core Result Codes** (stable, do not change):
- `1`: Success/Successful
- `2`: Nearest match (system not certain about providers; country identified)
- `3`: Transient error (temporary issue; retry may succeed)

**Important Notes**:
- Always check `result_code` even if HTTP status is 200
- API returns ResultCode in response even for HTTP 200 responses
- ResultCode=3 with HTTP 503 means transient error - implement retry logic

### Error Structure

**Error Object**:
```json
{
  "code": "string",        // Error code reference
  "context": "string"      // Optional context about the error
}
```

**Error Code Examples** (from official documentation):
- `INSUFFICIENT_BALANCE`: Account balance too low
- `INVALID_ACCOUNT_NUMBER`: Invalid phone/account number format
- `PROVIDER_UNAVAILABLE`: Mobile operator is down/unavailable
- `PROVIDER_TIMED_OUT`: Request to provider exceeded 90 seconds
- `DUPLICATE_REFERENCE`: Same distributor_ref submitted twice
- `INVALID_SKU_CODE`: Product code not found or disabled

**Error Code Discovery**:
- Call `/api/V1/GetErrorCodeDescriptions` endpoint to get all error code meanings
- System continues to add new error codes over time
- Cannot assume static list of codes

---

## 4. Processing Modes & Deferred Processing

### Instant Mode (Default)
- SendTransfer processes immediately
- Response contains ProcessingState = "Completed" or "Failed"
- Balance deducted immediately (on success)
- No webhook call

### Batch/Deferred Mode
- `X-Option: DeferTransfer` header on SendTransfer request
- Returns immediately with ProcessingState = "Submitted"
- Transfer processes later by DingConnect
- Webhook callback sent to `DeferredNotificationUrl` when complete
- Balance deducted upon submission (refunded if batch fails later)

**Deferred Webhook Payload**:
```json
{
  "transfer_id": "TXN20260301_001",
  "processing_state": "Completed",
  "account_number": "14155552671",
  "send_value": 25.00,
  "receive_value": 5.00,
  "receipt_text": "Success message from provider",
  "timestamp": "2026-03-01T14:30:45Z"
}
```

---

## 5. Request/Response Examples

### Example 1: Get Balance
```bash
curl -X GET "https://api.dingconnect.com/api/V1/GetBalance" \
  -H "X-Api-Key: your_api_key" \
  -H "Content-Type: application/json"
```

**Response**:
```json
{
  "result_code": 1,
  "balance": 1500.50,
  "currency_iso": "USD",
  "error_codes": []
}
```

### Example 2: Get Products
```bash
curl -X GET "https://api.dingconnect.com/api/V1/GetProducts?countryIsos=US&benefits=Data" \
  -H "X-Api-Key: your_api_key"
```

**Response** (partial):
```json
[
  {
    "sku_code": "US_VERIZON_5GB",
    "provider_code": "VERIZON",
    "localization_key": "us.verizon.5gb",
    "processing_mode": "Instant",
    "benefits": ["Data"],
    "uat_number": "1111111111",
    "commission_rate": 0.20,
    "default_display_text": "Verizon 5GB Data"
  }
]
```

### Example 3: SendTransfer (Instant Success)
```bash
curl -X POST "https://api.dingconnect.com/api/V1/SendTransfer" \
  -H "X-Api-Key: your_api_key" \
  -H "Content-Type: application/json" \
  -d '{
    "sku_code": "US_VERIZON_5GB",
    "send_value": 25.00,
    "account_number": "14155552671",
    "distributor_ref": "TXN20260301_001",
    "validate_only": false
  }'
```

**Response**:
```json
{
  "transfer_record": {
    "transfer_id": "TXN20260301_001",
    "sku_code": "US_VERIZON_5GB",
    "price": { "send_value": 25.00, "receive_value": 5.00 },
    "commission_applied": 5.00,
    "processing_state": "Completed",
    "receipt_text": "5GB data bundle successfully delivered",
    "account_number": "14155552671"
  },
  "result_code": 1,
  "error_codes": []
}
```

### Example 4: SendTransfer (Insufficient Balance)
```json
{
  "transfer_record": null,
  "result_code": 3,
  "error_codes": [
    {
      "code": "INSUFFICIENT_BALANCE",
      "context": "Required: $25.00, Available: $10.50"
    }
  ]
}
```

### Example 5: SendTransfer (Deferred Mode)
```bash
curl -X POST "https://api.dingconnect.com/api/V1/SendTransfer" \
  -H "X-Api-Key: your_api_key" \
  -H "X-Option: DeferTransfer" \
  -H "Content-Type: application/json" \
  -d '{
    "sku_code": "US_VERIZON_5GB",
    "send_value": 25.00,
    "account_number": "14155552671",
    "distributor_ref": "TXN20260301_002"
  }'
```

**Immediate Response**:
```json
{
  "transfer_record": {
    "transfer_id": "TXN20260301_002",
    "processing_state": "Submitted"
  },
  "result_code": 1,
  "error_codes": []
}
```

**Later Webhook POST to your URL**:
```json
{
  "transfer_id": "TXN20260301_002",
  "processing_state": "Completed",
  "account_number": "14155552671",
  "send_value": 25.00,
  "receive_value": 5.00,
  "receipt_text": "5GB data sent",
  "timestamp": "2026-03-01T14:35:22Z"
}
```

### Example 6: ValidateOnly (Preview)
```bash
curl -X POST "https://api.dingconnect.com/api/V1/SendTransfer" \
  -H "X-Api-Key: your_api_key" \
  -H "Content-Type: application/json" \
  -d '{
    "sku_code": "US_VERIZON_5GB",
    "send_value": 25.00,
    "account_number": "14155552671",
    "distributor_ref": "PREVIEW_001",
    "validate_only": true
  }'
```

**Response** (no balance deducted, no TransferId):
```json
{
  "transfer_record": {
    "sku_code": "US_VERIZON_5GB",
    "price": { "send_value": 25.00, "receive_value": 5.00 },
    "processing_state": "Validated"
  },
  "result_code": 1,
  "error_codes": []
}
```

### Example 7: List Transfer Records
```bash
curl -X POST "https://api.dingconnect.com/api/V1/ListTransferRecords" \
  -H "X-Api-Key: your_api_key" \
  -H "Content-Type: application/json" \
  -d '{ "skip": 0, "take": 10 }'
```

**Response**:
```json
[
  {
    "transfer_id": "TXN20260301_001",
    "processing_state": "Completed",
    "account_number": "14155552671",
    "sku_code": "US_VERIZON_5GB",
    "send_value": 25.00,
    "receive_value": 5.00,
    "started_utc": "2026-03-01T14:30:00Z",
    "completed_utc": "2026-03-01T14:30:45Z"
  }
]
```

---

## 6. Data Types & Enums

### TransferId
```
{
  "distributor_id": "string",      // Customer-provided ID
  "ding_id": "string"              // DingConnect system ID
}
```

### Price
```
{
  "send_value": number,
  "receive_value": number,
  "currency_iso": "string"
}
```

### Processing States
- `Submitted`: Awaiting processing (deferred mode)
- `Completed`: Successfully processed
- `Failed`: Transaction failed
- `Cancelled`: Transaction cancelled
- `Validated`: Validation-only (no TransferId)

### Processing Modes
- `Instant`: Immediate processing and response
- `Batch`: Deferred processing with webhook callback

### Benefits (Product Types)
- `Data`: Data bundles
- `Voice`: Minutes/airtime
- `SMS`: Text message bundles
- (Operator-specific benefits may vary)

---

## 7. Testing & UAT

### Test Numbers
- Available in GetProducts response as `uat_number` field
- Example: `1111111111` for US operators
- These numbers:
  - Always return success
  - Do not deduct balance
  - Work in both test and production accounts
  - Can be used for ongoing integration validation

### ValidateOnly Mode
- Use `validate_only: true` in SendTransfer to test without balance impact
- Validates syntax, checks provider availability, estimates pricing
- No actual transaction created

### Live Testing
- Even in production, use UAT test numbers from GetProducts
- Transition gradually from test to real transactions
- Monitor ListTransferRecords for validation

---

## 8. Integration Workflow

### Standard Top-Up Flow
1. **GetProducts** → Get available products for country
2. **Display to User** → Show product options with prices
3. **User Selection** → Customer chooses product and enters phone
4. **ValidateOnly** (optional) → Test with `validate_only=true`
5. **SendTransfer** → Submit actual transaction
   - Instant: Check ProcessingState in response
   - Deferred: Set up webhook and handle async notification
6. **Error Handling** → Check result_code and error_codes
7. **ListTransferRecords** → Track and reconcile transactions

### Error Handling Checklist
- [x] Always check `result_code`, not just HTTP status
- [x] For result_code=3 (transient): Implement exponential backoff retry
- [x] Call GetErrorCodeDescriptions for human-readable error meanings
- [x] Log error_codes[].context for debugging
- [x] Check GetBalance before transactions (optional but recommended)
- [x] Handle 90-second timeout for SendTransfer
- [x] For deferred mode: Validate webhook authenticity and idempotence
- [x] Implement ListTransferRecords daily for reconciliation

### Critical Implementation Points
1. **Result Code Checking**: First check result_code, then error_codes array
2. **Transient Errors**: result_code=3 means retry may succeed
3. **Webhook Security**: Validate deferred webhook authenticity
4. **Reconciliation**: Use ListTransferRecords for daily settlement
5. **Balance Management**: Monitor account balance and implement thresholds
6. **Test Numbers**: Always use UAT numbers from GetProducts during development
7. **Timeout Handling**: SendTransfer has 90-second limit; handle ProviderTimedOut error
8. **Duplicate Prevention**: Use unique distributor_ref to prevent duplicate charges

---

## 9. Rate Limits & Quotas

**Current Status**: Not specified in official documentation

**Recommendations**:
- Contact DingConnect support (support@dingconnect.com) for your account's limits
- Implement standard backoff for 429 (Too Many Requests) responses
- Monitor response times and adjust request patterns
- For batch operations: Use appropriate pagination (skip/take) in ListTransferRecords
- Typical SaaS APIs suggest per-minute or per-day rate limits

---

## 10. SDKs & Tools

### Official Tools
- **Swagger/OpenAPI**: https://api.dingconnect.com/swagger/docs/V1
- **Postman Workspace**: https://www.postman.com/dingconnect/dingconnect-public-workspace/

### Community Libraries

**PHP Client** (Unofficial but Well-Maintained)
- **GitHub**: https://github.com/parenthesislab/dingconnect-api-php
- **Installation**: `composer require parenthesis/dingconnect-api-php`
- **Covers**: All 16 V1 API methods
- **Features**: Model classes, exception handling, full type safety

### SDK Generation
Use OpenAPI Generator to create SDKs for:
- Python, Node.js, JavaScript
- Ruby, Java, Go, C#/.NET
- 15+ other languages

**Process**:
1. Download Swagger definition from `https://api.dingconnect.com/swagger/docs/V1`
2. Use `openapi-generator` tool
3. Generate client for your language
4. Include in dependencies

### Direct HTTP Usage
For languages without pre-built SDKs, use standard HTTP client:
- Include `X-Api-Key` or `Authorization` header
- POST/GET as specified
- Parse JSON responses

---

## 11. Official Documentation References

- **Main API Page**: https://www.dingconnect.com/Api
- **API Methods**: https://www.dingconnect.com/Api
- **FAQ**: https://www.dingconnect.com/api/faq
- **Help/Support**: https://dingconnect.zendesk.com/hc/en-us/categories/17856272784273-API-Guide
- **Support Email**: support@dingconnect.com

---

## 12. Key Integration Points Summary

| Aspect | Details |
|--------|---------|
| **Auth** | X-Api-Key header or OAuth 2.0 Bearer token |
| **Endpoints** | 16+ methods covering products, transfers, account, status |
| **Base URL** | https://api.dingconnect.com/api/V1/ |
| **Response Format** | JSON with result_code + error_codes array |
| **Processing** | Instant (immediate) or Deferred (webhook callback) |
| **Validation** | ValidateOnly=true for preview without charging |
| **Balance** | Use GetBalance; deducted on SendTransfer success |
| **Testing** | Use uat_number from GetProducts; no balance impact |
| **Reconciliation** | Use ListTransferRecords for daily settlement |
| **Timeout** | SendTransfer times out after 90 seconds |
| **Errors** | Check result_code first; use GetErrorCodeDescriptions |
| **Retries** | result_code=3 indicates transient; safe to retry |

---

## Sources

Official API documentation gathered from:
- [DingConnect API GitHub PHP Client - V1 API Reference](https://github.com/parenthesislab/dingconnect-api-php/blob/master/docs/Api/V1Api.md)
- [DingConnect API GitHub - SendTransferRequest Model](https://github.com/parenthesislab/dingconnect-api-php)
- [DingConnect API GitHub - TransferRecord Model](https://github.com/parenthesislab/dingconnect-api-php)
- [DingConnect API GitHub - Product Model](https://github.com/parenthesislab/dingconnect-api-php)
- [DingConnect Official Website - API Methods](https://www.dingconnect.com/Api)
- [DingConnect Official Website - API Description](https://www.dingconnect.com/Api/Description)
- [DingConnect Official Website - FAQ](https://www.dingconnect.com/api/faq)
- [DingConnect Postman Documentation](https://www.postman.com/dingconnect/dingconnect-public-workspace/documentation/x575l7u/dingconnect-api)
- [DingConnect Official Support - Zendesk](https://dingconnect.zendesk.com/hc/en-us/categories/17856272784273-API-Guide)
