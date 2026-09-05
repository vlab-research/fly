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

// A conversation whose `md` is gone, or hollowed out into a husk with no
// startTime. Same reasoning as RefDecodeError: it carries its own tag so it does
// not land in the STATE_ACTIONS catch-all.
//
// This one is not a study fault either, though. `md` is only ever CREATED by
// getMetadata() on a referral or a stitch; every other write MERGES, so once it
// is lost `{ ...undefined, ...eventMetadata }` produces a truthy husk that no
// later event can mend. The record is damaged and retrying cannot repair it --
// which is precisely what INTERNAL (the tag iowrap put on the getForm arity
// failure this used to become) told every consumer to do: page the on-call, and
// let dean redo it every 30 minutes forever, reproducing the identical error.
//
// MISSING_METADATA sits outside all three platform allow-lists -- dean's
// DEAN_ERROR_TAGS, dashboard-server's PLATFORM_ERROR_TAGS, and the
// PlatformInternalErrors alert -- all of which default an unrecognized tag to
// the non-platform side. So the participant lands in a visible, counted ERROR
// state that nothing retries and nobody is woken for, which is the honest
// description of a broken conversation record. Draining them is a backfill, not
// a retry. See documentation/states-debugging.md, "Blocking a participant
// destroys md", and documentation/study-error-alerting.md, "Error Taxonomy".
class MissingMetadataError extends Error {
  constructor(msg, details) {
    super(msg)
    this.tag = 'MISSING_METADATA'
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

module.exports = { MachineIOError, RefDecodeError, MissingMetadataError, iowrap }
