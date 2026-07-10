import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server', 'hrApi.js');
let content = fs.readFileSync(file, 'utf8');
const eol = content.includes('\r\n') ? '\r\n' : '\n';

if (!content.includes("from './apiError.js'")) {
  content = content.replace(
    "import { assertStaffUserIdInHrScope } from './hrStaffScope.js';",
    `import { assertStaffUserIdInHrScope } from './hrStaffScope.js';${eol}import { apiError } from './apiError.js';`
  );
}

if (!content.includes('function hrApiFail')) {
  content = content.replace(
    'function hrReady(res, db) {',
    `function hrApiFail(res, err, message, code = 'HR_REQUEST_FAILED') {${eol}  if (err) console.error(err);${eol}  return apiError(res, { status: 500, code, error: message });${eol}}${eol}${eol}function hrReady(res, db) {`
  );
}

const before = (content.match(/res\.status\(500\)\.json/g) || []).length;

content = content.replace(
  /return res\.status\(500\)\.json\(\{ ok: false, error: '([^']*)' \}\);/g,
  "return hrApiFail(res, e, '$1');"
);
content = content.replace(
  /res\.status\(500\)\.json\(\{ ok: false, error: '([^']*)' \}\);/g,
  "return hrApiFail(res, e, '$1');"
);

content = content.replace(
  new RegExp(`console\\.error\\(e\\);${eol}(\\s+)return hrApiFail`, 'g'),
  '$1return hrApiFail'
);

const after = (content.match(/res\.status\(500\)\.json/g) || []).length;
fs.writeFileSync(file, content);
console.log(`hrApi.js: replaced ${before - after} of ${before} status(500) handlers; ${after} remaining`);
