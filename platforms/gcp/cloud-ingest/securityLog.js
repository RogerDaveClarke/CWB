const { createHash } = require('node:crypto');

function pseudonymousId(value) {
  if (!value) return undefined;
  return createHash('sha256').update(String(value), 'utf8').digest('hex').slice(0, 16);
}

function logSecurityEvent(event, details = {}, severity = 'NOTICE') {
  const record = {
    severity,
    securityEvent: event,
    ...details
  };
  console.log(JSON.stringify(record));
}

module.exports = { logSecurityEvent, pseudonymousId };