'use strict';

/*
 * Export operations, req-free, shared by the REST controller and the MCP
 * tools.
 *
 * An export is asynchronous: starting one inserts a `Requested` row into
 * export_status and returns its id. The exporter (exporter/exporter/main.py)
 * polls that table — nothing is published to Kafka, whatever older docs say —
 * and moves the row through Processing to Completed (with a presigned download
 * link valid for 7 hours) or Failed. Listing is how a caller learns which.
 */

const crypto = require('crypto');

const { Exports, User } = require('../../queries');

// The `source` column is the exporter's dispatch key. Anything that is not one
// of the two named kinds is a plain responses export, which is also what the
// UI sends when it omits export_type.
const SOURCE_MAP = { chat_log: 'chat_log', full_messages: 'full_messages' };
const sourceFor = export_type => SOURCE_MAP[export_type] || 'responses';

/*
 * Ownership is NOT checked here: export_status is keyed by the caller's email
 * and the exporter scopes its own query by that email, so a row for a survey
 * the caller does not own simply exports nothing. The MCP tool resolves the
 * survey first anyway, to refuse with a useful message before inserting.
 */
async function startExport({ email, survey_name, export_type, options = {} }) {
  const source = sourceFor(export_type);
  const exportId = crypto.randomUUID();
  await Exports.insert(exportId, email, survey_name, source, options);
  return { export_id: exportId, source, status: 'Requested' };
}

/*
 * Rows newest first. Without survey_name it is every export the caller has
 * ever requested. `Exports.all` throws when the user row does not exist; a key
 * whose account is gone has no exports, and an empty list says that better
 * than a 500.
 */
async function listExports({ email, survey_name }) {
  if (survey_name) {
    const { responses } = await Exports.bySurvey(email, survey_name);
    return responses;
  }

  const user = await User.user({ email });
  if (!user) return [];

  const { responses } = await Exports.all(email);
  return responses;
}

module.exports = { startExport, listExports, sourceFor, SOURCE_MAP };
