const mustache = require('mustache')
const util = require('util')
const _ = require('lodash')
const { hash } = require('./utils')
const { translator, addCustomType: baseAddCustomType, normalizeUnicodeNumerals, parseNumber } = require('@vlab-research/translate-typeform')
const yaml = require('js-yaml')

class FieldError extends Error { }

// Wrapper for type-casting values in comparisons.
// Uses parseNumber for proper handling of unicode numerals and decimals.
// Falls back to yaml.safeLoad for non-numeric values (booleans, strings).
function safeLoadWithNormalization(value) {
  // Try parseNumber first - handles unicode digits and preserves decimals
  const num = parseNumber(value)
  if (num !== null) {
    return num
  }
  // Fall back to yaml.safeLoad for booleans, strings, etc.
  const normalized = normalizeUnicodeNumerals(value)
  return yaml.safeLoad(normalized)
}

function getSeed(md, key) {
  // format: seed_12 or seed_12_1 or seed_12_2
  // can be used to create distinct seeds 
  const [__, match, multiple] = /_(\d+)_?(\d+)?/g.exec(key)

  let seed = md.seed;

  if (multiple) {
    const m = +multiple
    for (let i = 0; i < m; i++) {
      seed = hash(seed)
    }
  }

  return seed % (+match) + 1
}

// METADATA consists of:

// 1. Anything on the user object (id, name, first_name, last_name)
// 2. Anything sent in the original url "ref" query param (i.e. form, via ?ref=form.foo)
// 3. A random seed, given by 'seed_2' or 'seed_7' or 'seed_N' for any number needed
function getFromMetadata(ctx, key) {
  const { user, md } = ctx

  const meta = { ...user, ...md }

  if (meta[key] === undefined) {

    if (/seed_/.test(key)) {
      return getSeed(md, key)
    }
    return ""
  }

  return meta[key]
}

function getDynamicValue(ctx, qa, v) {
  const [loc, key] = v.split(':')
  const val = loc === 'hidden' ?
    getFromMetadata(ctx, key) :
    getFieldValue(qa, key)

  if (val === undefined || val === null) {
    throw new TypeError(`Trying to interpolate a non-existent value: ${v}`)
  }

  return val
}

function _zip(a, b) {
  // zips two arrays together, alternating, starting with a
  if (!a || !b) return a.concat(b)
  const len = a.length + b.length
  const arr = []
  for (let i = 0; i < len; i++) {
    i % 2 ? arr.push(b.shift()) : arr.push(a.shift())
  }
  return arr
}

function _splitUrls(s) {
  const re = RegExp(/https?:\/\/[^\s]+/ig)
  const nonMatches = s.split(re).map(s => ['text', s])
  if (re.test(s)) {
    const matches = s.match(re).map(s => ['url', s])
    return _zip(nonMatches, matches).filter(a => !!a[1])
  }
  return nonMatches
}

function _interpolate(ctx, qa, s, encode) {
  const lookup = encode ?
    v => encodeURIComponent(getDynamicValue(ctx, qa, v)) :
    v => getDynamicValue(ctx, qa, v)

  return mustache.parse(s)
    .map(t => t[0] === 'name' ? lookup(t[1]) : t[1])
    .join('')
}

function interpolate(ctx, qa, s) {
  if (!s) return s

  return _splitUrls(s)
    .map(([type, val]) => {
      if (type === 'url') return _interpolate(ctx, qa, val, true)
      if (type === 'text') return _interpolate(ctx, qa, val, false)
    })
    .join('')
}

function deTypeformify(s) {
  if (!s) return s

  s = s.replace(/\\_/g, '_')

  return s
}

function interpolateField(ctx, qa, field) {
  const keys = ['title', 'properties.description']
  const out = { ...field }

  keys.forEach(k => _.set(out, k, deTypeformify(_.get(out, k))))
  keys.forEach(k => _.set(out, k, interpolate(ctx, qa, _.get(out, k))))
  return out
}

function translateField(ctx, qa, field) {
  return translator(addCustomType(interpolateField(ctx, qa, field)))
}

function getField({ form, user }, ref, index = false) {
  if (!form.fields.length) {
    throw new FieldError(`This form has no fields: ${form.id}`)
  }

  if (!user || !user.id) {
    throw new FieldError(`Invalid user object when getting field ${ref} in form ${form.id}`)
  }

  const idx = form.fields.map(({ ref }) => ref).indexOf(ref)
  const field = form.fields[idx]

  if (!field) {
    throw new FieldError(`Could not find the requested field, ${ref}, in our form: ${form.id}, for user id: ${user.id}!`)
  }

  return index ? [idx, field] : field
}

function _isLast(form, field) {
  const idx = form.fields.findIndex(({ ref }) => ref === field)
  return idx === form.fields.length - 1
}

function _getNext(form, currentRef) {
  // TODO: work out this ending logic....
  // this should never be reached??
  if (_isLast(form, currentRef)) {
    return null
  }

  const idx = form.fields.findIndex(({ ref }) => ref === currentRef)
  return form.fields[idx + 1]
}

function getNextField(ctx, qa, currentField) {
  const { form } = ctx

  const logic = form.logic && form.logic.find(({ ref }) => ref === currentField)

  if (logic) {
    const nxt = jump(ctx, qa, logic)
    const field = getField(ctx, nxt)
    return field
  }

  return _getNext(form, currentField)
}


function jump(ctx, qa, logic) {
  // TODO: Handle case where logic fails and
  // there is no default -- proper error and
  // maybe work out a new state... "blocked?"

  const { ref, actions } = logic

  for (let { condition, details } of actions) {
    if (getCondition(ctx, qa, ref, condition)) {
      return details.to.value
    }
  }

  // Default to next field if none found
  return _getNext(ctx.form, ref).ref
}

function getFieldValue(qa, ref) {
  // last valid answer
  const match = qa.filter(([q, __]) => q === ref).pop()

  // return null if there are no matches,
  // or if there are no answers,
  const ans = match && match[1]
  return ans ? ans : null
}

const funs = {
  'and': (a, b) => a && b,
  'or': (a, b) => a || b,
  'greater_than': (a, b) => a > b,
  'lower_than': (a, b) => a < b,
  'greater_equal_than': (a, b) => a >= b,
  'lower_equal_than': (a, b) => a <= b,
  'is': (a, b) => a === b,
  'equal': (a, b) => a === b,
  'is_not': (a, b) => a !== b,
  'not_equal': (a, b) => a !== b,
  'contains': (a, b) => a !== undefined && a.includes(b),
  'not_contains': (a, b) => a === undefined || !a.includes(b),
}


function getCondition(ctx, qa, ref, { op, vars }) {
  if (op === 'always') return true

  const f = funs[op]

  if (!f) {
    throw new TypeError(`Cannot find operation: ${op}\nquestion: ${ref}`)
  }

  // wrap in safeLoadWithNormalization to perform type-casting
  // from form data (strings) to js native types while normalizing
  // unicode numerals. This enables correct numeric comparisons for
  // users entering numbers in any script (Arabic, Devanagari, etc.)
  const fn = (a, b) => f(safeLoadWithNormalization(a), safeLoadWithNormalization(b))

  // getChoiceValue needs to ref from the "field" type,
  // which it is always paired with....

  // vars should be length 2 unless and/or in which case
  // can be length unlimited so we reduce through logic
  return vars.map((v) => getVar(ctx, qa, ref, v, vars)).reduce(fn)
}

function getChoiceValue({ form }, ref, choice) {
  const val = form.fields
    .find(f => f.ref === ref)
    .properties.choices
    .find(c => c.ref === choice)
    .label

  if (!val) {
    throw new TypeError(`Could not find value for choice: ${choice} in question ${ref}`)
  }

  return val
}


function getVar(ctx, qa, ref, v, vars) {
  if (v.op) {
    return getCondition(ctx, qa, ref, v)
  }

  const { type, value } = v

  if (type == 'constant') {
    return value
  }

  if (type == 'choice') {
    const field = vars.find(v => v.type === 'field').value
    return getChoiceValue(ctx, field, value)
  }

  if (type == 'field') {
    return getFieldValue(qa, value)
  }

  if (type == 'hidden') {
    return getFromMetadata(ctx, value)
  }
}


// Extended addCustomType with handoff support
function addCustomType(field) {
  const result = baseAddCustomType(field)
  
  // Check if this is a handoff question
  if (result.properties && result.properties.description) {
    try {
      const config = yaml.load(result.properties.description)
      if (config && config.type === 'handoff') {
        // Generate wait condition with handover event type
        const wait = config.wait || { 
          op: 'or',
          vars: [
            { type: 'handover', value: { target_app_id: config.target_app_id } },
            { type: 'timeout', value: `${config.timeout_minutes || 60}m` }
          ]
        }
        
        return {
          ...result,
          handoff: {
            target_app_id: config.target_app_id,
            wait: wait,
            metadata: {
              survey_id: config.survey_id,
              question_ref: result.ref,
              ...config.metadata
            }
          }
        }
      }
    } catch (e) {
      // Not YAML or not handoff type, continue with base result
    }
  }
  
  return result
}

module.exports = {
  getCondition,
  getFieldValue,
  jump,
  getField,
  getNextField,
  translateField,
  interpolateField,
  addCustomType,
  getFromMetadata,
  FieldError,
  _splitUrls,
  deTypeformify,
}
