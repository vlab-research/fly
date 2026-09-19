const { parsePhoneNumberFromString } = require('libphonenumber-js')

// Respondents type their number with and without the leading +, with spaces,
// dashes and trailing words. A bare national number is only resolvable against
// a country, which a phone_number question carries in
// properties.default_country_code.
function parsePhone(value, country) {
  if (typeof value !== 'string' && typeof value !== 'number') return null

  const raw = ('' + value).trim()
  if (!raw) return null

  // Without a country the only resolvable shape is international, and people
  // routinely omit the +, so try it both ways before giving up.
  const candidates = raw.startsWith('+') ? [raw] : [raw, '+' + raw]

  // libphonenumber only knows upper-case region codes, and forms carry both.
  const region = country ? ('' + country).toUpperCase() : undefined

  for (const candidate of candidates) {
    const parsed = parsePhoneNumberFromString(candidate, region)
    if (parsed && parsed.isValid()) return parsed
  }

  return null
}

function isValidPhone(value, country) {
  return parsePhone(value, country) !== null
}

// The E.164 of an Argentine mobile carries a carrier-select 9 after the country
// code. DingConnect is sent the national form without it: that is the shape
// this account's Argentine transfers are accepted in, and the 9 form is
// untested against it. Changing this changes what every AR respondent is paid on.
function _forProvider(parsed) {
  if (parsed.country === 'AR') {
    return '+' + parsed.countryCallingCode + parsed.nationalNumber.replace(/^9/, '')
  }
  return parsed.number
}

// Null when the number cannot be resolved, so callers can tell "not a phone
// number" from "a phone number in some other shape".
function normalizePhone(value, country) {
  const parsed = parsePhone(value, country)
  return parsed ? _forProvider(parsed) : null
}

module.exports = { parsePhone, isValidPhone, normalizePhone }
