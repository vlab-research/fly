'use strict';

/*
 * Bail-system operations, req-free, shared by the REST controller's callers
 * and the MCP tools.
 *
 * The REST routes are addressed by `/users/:userId/...` and the dashboard gets
 * that id by calling POST /users (get-or-create) on mount. An agent never sees
 * a user id: `resolveVlabUser` does the same get-or-create from the caller's
 * email, and every operation here takes the resolved user.
 *
 * The operations themselves are utils/bails, which talks to the Exodus service
 * over HTTP. Exodus failures arrive as errors carrying `status`; they are the
 * caller's own bad input (or Exodus being down) and are marked `expected` so
 * a tool can show the message verbatim.
 */

const { User } = require('../../queries');
const { BailsUtil } = require('../../utils');

class BailFailure extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'BailFailure';
    this.expected = true;
    this.status = status;
  }
}

// What validateUserAccess and the UI's POST /users do together.
async function resolveVlabUser({ email }) {
  const existing = await User.user({ email });
  if (existing) return { id: existing.id, email: existing.email };
  const created = await User.create({ email });
  return { id: created.id, email: created.email };
}

// Exodus answers 4xx with a message worth relaying; anything else is ours.
async function exodus(promise) {
  try {
    return await promise;
  } catch (err) {
    if (err && err.status && err.status < 500) throw new BailFailure(err.message, err.status);
    throw err;
  }
}

const listBails = ({ id }) => exodus(BailsUtil.listBails(id));
const getBail = ({ id }, bailId) => exodus(BailsUtil.getBail(id, bailId));
const createBail = ({ id }, bail) => exodus(BailsUtil.createBail(id, bail));
const updateBail = ({ id }, bailId, bail) => exodus(BailsUtil.updateBail(id, bailId, bail));
const deleteBail = ({ id }, bailId) => exodus(BailsUtil.deleteBail(id, bailId));
const previewBail = ({ id }, definition) => exodus(BailsUtil.previewBail(id, definition));
const bailEvents = ({ id }, bailId) => exodus(BailsUtil.getBailEvents(id, bailId));
const userBailEvents = ({ id }, limit) => exodus(BailsUtil.getUserEvents(id, limit));

module.exports = {
  BailFailure,
  resolveVlabUser,
  listBails,
  getBail,
  createBail,
  updateBail,
  deleteBail,
  previewBail,
  bailEvents,
  userBailEvents,
};
