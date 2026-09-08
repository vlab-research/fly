'use strict';

/*
 * The real dependencies of the media service, built once and shared by the
 * REST routes and the MCP layer, so the two cannot be wired to different
 * storage.
 */

const { Credential, Media } = require('../../queries');
const { STORAGE } = require('../../config');
const { makeStorage } = require('./storage');
const { uploadToPlatform } = require('./media.platform-upload');

module.exports = {
  credentialQuery: Credential,
  mediaQuery: Media,
  storage: makeStorage(STORAGE),
  platformUpload: uploadToPlatform,
};
