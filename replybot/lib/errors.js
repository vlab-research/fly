class MachineIOError extends Error {
  constructor(tag, msg, details) {
    super(msg)
    this.tag = tag
    this.details = details
  }
  get name() {
    return this.constructor.name;
  }
}

// An encoded recruitment ref (`r.<base64url>`) that will not decode.
//
// IT CARRIES ITS OWN TAG, and that is the point of the class rather than a bare
// throw. transition.js reads `e.tag || 'STATE_ACTIONS'`, and STATE_ACTIONS sits
// in every consumer's platform allow-list — so an untagged throw here would
// page the platform on-call for a study's broken ad, with a runbook that leads
// nowhere. REF_DECODE routes it to the study side, where it becomes a ticket
// against the study whose ad is wrong. See documentation/study-error-alerting.md.
//
// WHY THROW AT ALL, rather than resolving nothing and carrying on. The
// alternative is md.form falling through to FALLBACK_FORM — a real survey
// belonging to a real researcher, where the misrouted respondent answers
// questions, reaches END, and is indistinguishable from a completion. That is
// the VIR-19 shape, and it is exactly what this ref format is meant to avoid:
// an encoded ref is the ONLY carrier of the shortcode, so if it will not decode
// we do not know the survey and must not guess. An ERROR state is visible,
// counted and alertable; a wrong survey is none of those.
class RefDecodeError extends Error {
  constructor(msg, details) {
    super(msg)
    this.tag = 'REF_DECODE'
    this.details = details
  }
  get name() {
    return this.constructor.name;
  }
}

async function iowrap(msg, tag, fn, ...args) {
  try {
    const res = await fn(...args)
    return res
  } catch (e) {

    if (e instanceof MachineIOError) {
      throw e
    }

    const err = new MachineIOError(tag, msg, e.details)
    err.stack = e.stack
    throw err
  }
}

module.exports = { MachineIOError, RefDecodeError, iowrap }
