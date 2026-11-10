// Pakistani + international sensitive-data detection.
// Uses the same detector as screenshots (through scrubTextSync for text, and
// hand-made OCR layouts for label + value cases).
//
//   node group2/tests/node/international.test.mjs

import { readFileSync } from 'node:fs';
import { SensitiveClassifier } from '../../detection/mlClassifier.js';
import { detectSensitive, buildScrubbedText } from '../../detection/detector.js';
import { scrubTextSync } from '../../privacy/textScrubber.js';

const root = new URL('../../../', import.meta.url);
const clf = new SensitiveClassifier(JSON.parse(readFileSync(new URL('group2/model/sensitive_model.json', root))));
const IMAGE = { width: 1600, height: 1000 };

let failed = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failed += 1;
}

// [input, expected type, raw text that must disappear, text that must stay (optional)]
const MUST_HIDE = [
  // ---- Pakistan (existing behaviour) ----
  ['CNIC: 35202-1234567-8', 'cnic', '35202-1234567-8'],
  ['My CNIC is 3520212345678', 'cnic', '3520212345678'],
  ['Mobile 0300-1234567', 'phone', '1234567'],
  ['Call +92 300 1234567', 'phone', '1234567'],
  ['IBAN PK36SCBL0000001123456702', 'iban', 'PK36SCBL0000001123456702'],
  // ---- Email / phone ----
  ['Contact john.doe@acme.co.uk today', 'email', 'john.doe', 'today'],
  ['US office +1 (415) 555-2671', 'phone', '555-2671', 'office'],
  ['London +44 20 7946 0958', 'phone', '7946'],
  ['Dubai +971 50 123 4567', 'phone', '4567'],
  ['India +91 98765 43210', 'phone', '43210'],
  // ---- National IDs ----
  ['SSN: 123-45-6789', 'national_id', '6789'],
  ['Employee SSN 123456789 on file', 'national_id', '123456789', 'Employee'],
  ['NI number AB 12 34 56 C', 'national_id', '34'],
  ['PAN ABCPE1234F', 'national_id', 'ABCPE1234F'],
  ['Aadhaar 2345 6789 0124', 'national_id', '6789'],
  // ---- Passports ----
  ['Passport No. AB1234567 issued', 'passport', 'AB1234567', 'issued'],
  ['passport number 123456789', 'passport', '123456789'],
  ['P<GBRSMITH<<JOHN<<<<<<<<<<<<<<<<<<<<<<<<<<<<', 'passport', 'SMITH'],
  // ---- Financial ----
  ['Card 4111 1111 1111 1111', 'credit_card', '1111'],
  ['Amex 3782 822463 10005', 'credit_card', '822463'],
  ['IBAN GB82 WEST 1234 5698 7654 32', 'iban', '5698'],
  ['Pay to DE89 3704 0044 0532 0130 00', 'iban', '0532'],
  ['SWIFT: DEUTDEFF500', 'bank_account', 'DEUTDEFF500'],
  ['BIC code HBUKGB4B', 'bank_account', 'HBUKGB4B'],
  // ---- Passwords / credentials ----
  ['Password: MySecret123', 'password', 'MySecret123'],
  ['DB_PASSWORD=Hunter2!', 'password', 'Hunter2'],
  ['passphrase: correct-horse-battery', 'password', 'correct-horse'],
  ['postgres://admin:S3cretPw@db.example.com:5432/app', 'password', 'S3cretPw'],
  // ---- API keys / tokens ----
  ['AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', 'api_key', 'wJalrXUtnFEMI'],
  ['key AKIAIOSFODNN7EXAMPLE', 'api_key', 'AKIAIOSFODNN7EXAMPLE'],
  ['OPENAI_API_KEY sk-proj-Ab3dEf6hIj9kLm2nOp5qRs8t', 'api_key', 'sk-proj'],
  ['Anthropic sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv', 'api_key', 'sk-ant'],
  ['Slack xoxb-1234567890-abcdefghij', 'api_key', 'xoxb'],
  ['Use github_pat_11ABCDEFG0123456789_abcdefghijklmnop', 'api_key', 'github_pat'],
  ['GitLab glpat-AbCdEfGh1234567890ij', 'api_key', 'glpat'],
  ['SG.AbCdEfGhIjKlMnOp12.QrStUvWxYz0123456789ab', 'api_key', 'SG.'],
  ['Authorization: Basic dXNlcjpwYXNzd29yZA==', 'api_key', 'dXNlcjpwYXNzd29yZA'],
  ['Authorization: Bearer abc.def-ghi_jkl123', 'api_key', 'abc.def'],
  ['-----BEGIN RSA PRIVATE KEY-----', 'api_key', 'PRIVATE'],
  ['client_secret=9f8e7d6c5b4a', 'api_key', '9f8e7d6c5b4a'],
];

for (const [input, type, raw, keep] of MUST_HIDE) {
  const r = scrubTextSync(input, clf);
  const ok = r.types.includes(type) && !r.text.includes(raw) && (!keep || r.text.includes(keep));
  check(`hide ${type.padEnd(12)} "${input}"`, ok, r.text);
}

// Normal text that must not be masked.
const MUST_KEEP = [
  'Pin this message', 'Swift delivery options', 'Basic Information', 'Account Settings',
  'Passport photo requirements', 'Version 2.10.3', 'Order #12345', 'Total: $1,234.56',
  'Forgot password?', 'Enter your password', 'Token expired', 'National Insurance overview',
  'BACKUP SETTINGS', 'Social Security benefits', 'Mail', 'Expiration',
];
for (const input of MUST_KEEP) {
  const r = scrubTextSync(input, clf);
  check(`keep "${input}"`, !r.changed, r.text);
}

// ---- Label + value laid out like a real form (spatial rules) ----
function mkLine(index, items) {
  let text = '';
  const words = items.map(([t, x, y, w, h]) => {
    if (text) text += ' ';
    const start = text.length;
    text += t;
    return { text: t, conf: 90, box: { x, y, w, h }, lineIndex: index, start, end: text.length };
  });
  return { index, text, box: { x: words[0].box.x, y: words[0].box.y, w: 1, h: 1 }, words };
}

const FORMS = [
  // [label words, value, expected type]
  [['Passport', 'Number:'], 'X12345678', 'passport'],
  [['Social', 'Security', 'Number'], '078-05-1120', 'national_id'],
  [['Routing', 'number:'], '021000021', 'bank_account'],
  [['Account', 'No:'], '000123456789', 'bank_account'],
  [['Sort', 'code:'], '20-00-00', 'bank_account'],
  [['Date', 'of', 'birth:'], '1990-04-15', 'date_of_birth'],
  [['OTP:'], '482913', 'password'],
  [['Expiry', 'Date:'], '12/27', 'credit_card'],
  [['Tax', 'ID:'], '12-3456789', 'national_id'],
  [['CNIC', 'No:'], '42101-9876543-1', 'cnic'],
];
for (const [label, value, type] of FORMS) {
  let x = 100;
  const items = label.map((t) => { const w = [t, x, 100, t.length * 12, 20]; x += t.length * 12 + 8; return w; });
  // value in a separate OCR line on the same row (PSM 11 style)
  const lines = [mkLine(0, items), mkLine(1, [[value, x + 60, 101, value.length * 12, 20]])];
  const { piiRegions } = detectSensitive(lines, IMAGE, clf);
  const text = buildScrubbedText(lines, piiRegions);
  check(`form "${label.join(' ')} ${value}" -> ${type}`, piiRegions.some((r) => r.type === type) && !text.includes(value), text.replace('\n', ' | '));
}
{
  // Label with the value BELOW it (stacked form field)
  const lines = [mkLine(0, [['Passport', 100, 100, 100, 20]]), mkLine(1, [['K98765432', 100, 140, 120, 20]])];
  const { piiRegions } = detectSensitive(lines, IMAGE, clf);
  check('passport value below its label is masked', piiRegions.some((r) => r.type === 'passport'), JSON.stringify(piiRegions));
}
{
  // "Passport" menu item next to a normal word: nothing masked
  const lines = [mkLine(0, [['Passport', 100, 100, 100, 20]]), mkLine(1, [['Services', 260, 100, 100, 20]])];
  const { piiRegions } = detectSensitive(lines, IMAGE, clf);
  check('"Passport" menu item next to "Services" is not masked', piiRegions.length === 0, JSON.stringify(piiRegions));
}

console.log(failed ? `\n${failed} test(s) FAILED` : '\nAll international detection tests passed');
process.exit(failed ? 1 : 0);
