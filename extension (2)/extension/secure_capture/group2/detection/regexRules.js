// High-confidence regex rules. Each rule runs on the text of one OCR line.
// To add a rule, add an object to REGEX_RULES:
//   { name, type, pattern (with /g), validate?(matchText) -> boolean,
//     valueGroup? (capture group to mask instead of the whole match) }
// Matches are mapped back to the OCR words they cover, and those word
// boxes become PII regions.

const digitsOf = (s) => s.replace(/\D/g, '');

function luhnValid(num) {
  const d = digitsOf(num);
  if (d.length < 13 || d.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = d.length - 1; i >= 0; i--) {
    let n = Number(d[i]);
    if (double) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
    double = !double;
  }
  return sum % 10 === 0;
}

// IBAN check digits (ISO 13616, mod 97). Spaces are ignored.
function ibanValid(s) {
  const iban = s.replace(/\s/g, '').toUpperCase();
  if (iban.length < 15 || iban.length > 34) return false;
  const moved = iban.slice(4) + iban.slice(0, 4);
  let rem = 0;
  for (const ch of moved) {
    const v = /\d/.test(ch) ? ch : String(ch.charCodeAt(0) - 55);
    for (const d of v) rem = (rem * 10 + Number(d)) % 97;
  }
  return rem === 1;
}

// Verhoeff checksum, used by Indian Aadhaar numbers.
const VERHOEFF_D = [[0,1,2,3,4,5,6,7,8,9],[1,2,3,4,0,6,7,8,9,5],[2,3,4,0,1,7,8,9,5,6],[3,4,0,1,2,8,9,5,6,7],[4,0,1,2,3,9,5,6,7,8],[5,9,8,7,6,0,4,3,2,1],[6,5,9,8,7,1,0,4,3,2],[7,6,5,9,8,2,1,0,4,3],[8,7,6,5,9,3,2,1,0,4],[9,8,7,6,5,4,3,2,1,0]];
const VERHOEFF_P = [[0,1,2,3,4,5,6,7,8,9],[1,5,7,6,2,8,3,0,9,4],[5,8,0,3,7,9,6,1,4,2],[8,9,1,6,0,4,3,5,2,7],[9,4,5,3,1,2,6,8,7,0],[4,2,8,6,5,7,3,9,0,1],[2,7,9,3,8,0,6,4,1,5],[7,0,4,6,9,1,3,2,5,8]];
function verhoeffValid(num) {
  let c = 0;
  digitsOf(num).split('').reverse().forEach((d, i) => { c = VERHOEFF_D[c][VERHOEFF_P[i % 8][Number(d)]]; });
  return c === 0;
}

// Shannon entropy in bits per character. Random keys are high (> 3.5),
// normal words are low.
export function entropy(s) {
  const freq = {};
  for (const ch of s) freq[ch] = (freq[ch] || 0) + 1;
  let e = 0;
  for (const k in freq) { const p = freq[k] / s.length; e -= p * Math.log2(p); }
  return e;
}

export const REGEX_RULES = [
  {
    name: 'email',
    type: 'email',
    pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g,
  },
  {
    // Pakistani CNIC: 12345-1234567-1 (also accepts spaces or no separators)
    name: 'cnic',
    type: 'cnic',
    pattern: /(?<!\d)\d{5}[-\s]?\d{7}[-\s]?\d(?!\d)/g,
  },
  {
    name: 'credit_card',
    type: 'credit_card',
    pattern: /(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g,
    // A dashed 5-7-1 group is a Pakistani CNIC, even when it happens to pass Luhn
    validate: (m) => luhnValid(m) && !/^\d{5}[-\s]\d{7}[-\s]\d$/.test(m),
  },
  {
    // Phone numbers: 10 to 15 digits with optional +, spaces, dashes, brackets.
    // Examples: 03001234567, 0300-1234567, +92 300 1234567, +92 42 1234 5678
    name: 'phone',
    type: 'phone',
    pattern: /(?<![\w/])\+?\(?\d[\d\s().-]{7,}\d(?![\w/])/g,
    validate: (m) => {
      const n = digitsOf(m).length;
      return n >= 10 && n <= 15;
    },
  },
  {
    name: 'iban',
    type: 'iban',
    pattern: /\b[A-Z]{2}\d{2}[A-Z]{4}\d{10,26}\b/g,
  },
  {
    // Any country's IBAN, with or without spaces: GB82 WEST 1234 5698 7654 32
    name: 'iban_international',
    type: 'iban',
    pattern: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?\b/g,
    validate: ibanValid,
  },
  {
    // "SWIFT: DEUTDEFF500", "BIC code HBUKGB4B" (only with the label, a bare
    // 8-letter word is too often a normal word)
    name: 'swift_bic',
    type: 'bank_account',
    pattern: /\b(?:SWIFT|BIC)(?:[\s/]*(?:BIC|code))?\s*[:#-]?\s*([A-Z]{6}[A-Z0-9]{2}(?:[A-Z0-9]{3})?)\b/gi,
    valueGroup: 1,
    validate: (m) => /^[A-Z]{6}[A-Z0-9]{2,5}$/.test(m),
  },
  // ---- International national IDs ----
  {
    // US Social Security Number, dashed: 123-45-6789 (invalid ranges skipped)
    name: 'us_ssn',
    type: 'national_id',
    pattern: /(?<![\d-])(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}(?![\d-])/g,
  },
  {
    // "SSN 123456789", "Social Security No. 123 45 6789"
    name: 'us_ssn_context',
    type: 'national_id',
    pattern: /\b(?:SSN|social\s+security(?:\s+(?:no\.?|number|#))?)\s*[:#-]?\s*(\d{3}[-\s]?\d{2}[-\s]?\d{4})(?!\d)/gi,
    valueGroup: 1,
  },
  {
    // UK National Insurance number: QQ 12 34 56 C
    name: 'uk_nino',
    type: 'national_id',
    pattern: /\b[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z] ?\d{2} ?\d{2} ?\d{2} ?[A-D]\b/g,
  },
  {
    // Indian Aadhaar: 2345 6789 0123 (groups of 4, Verhoeff check)
    name: 'in_aadhaar',
    type: 'national_id',
    pattern: /(?<![\d-])[2-9]\d{3}[\s-]\d{4}[\s-]\d{4}(?![\d-])/g,
    validate: verhoeffValid,
  },
  {
    // Indian PAN: ABCPE1234F
    name: 'in_pan',
    type: 'national_id',
    pattern: /\b[A-Z]{3}[ABCFGHJLPT][A-Z]\d{4}[A-Z]\b/g,
  },
  // ---- Passports ----
  {
    // "Passport No. AB1234567", "Passport number: 123456789"
    name: 'passport_context',
    type: 'passport',
    pattern: /\bpassport(?:\s*(?:no\.?|number|num|#))?\s*[:#.-]?\s*([A-Z0-9]{6,10})\b/gi,
    valueGroup: 1,
    validate: (m) => /\d/.test(m) && /^[A-Z0-9]+$/.test(m),
  },
  {
    // Machine-readable zone of a passport / ID card: P<GBRSMITH<<JOHN<<<<<...
    name: 'mrz',
    type: 'passport',
    pattern: /[A-Z0-9<]*<<[A-Z0-9<]*/g,
    validate: (m) => m.length >= 25,
  },
  // ---- Credentials in URLs ----
  {
    // postgres://admin:S3cret@db.example.com, https://user:pass@host
    name: 'url_credentials',
    type: 'password',
    pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]+@[^\s/]+/gi,
  },
  // ---- API keys and tokens ----
  { name: 'aws_access_key', type: 'api_key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: 'openai_anthropic_key', type: 'api_key', pattern: /\bsk-(?:ant-|proj-|live-|svcacct-)?[A-Za-z0-9_-]{20,}/g },
  { name: 'slack_token', type: 'api_key', pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { name: 'slack_webhook', type: 'api_key', pattern: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]+/g },
  { name: 'github_pat', type: 'api_key', pattern: /\bgithub_pat_[A-Za-z0-9_]{22,}/g },
  { name: 'gitlab_token', type: 'api_key', pattern: /\bglpat-[A-Za-z0-9_-]{20,}/g },
  { name: 'google_oauth_token', type: 'api_key', pattern: /\bya29\.[0-9A-Za-z_-]{20,}/g },
  { name: 'sendgrid_key', type: 'api_key', pattern: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g },
  { name: 'npm_token', type: 'api_key', pattern: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { name: 'shopify_token', type: 'api_key', pattern: /\bshp(?:at|ca|pa|ss)_[a-fA-F0-9]{32}\b/g },
  { name: 'twilio_sid', type: 'api_key', pattern: /\b(?:AC|SK)[a-f0-9]{32}\b/g },
  { name: 'mailgun_key', type: 'api_key', pattern: /\bkey-[a-f0-9]{32}\b/g },
  { name: 'private_key_block', type: 'api_key', pattern: /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/g },
  {
    name: 'basic_auth',
    type: 'api_key',
    pattern: /\bBasic\s+[A-Za-z0-9+/]{12,}={0,2}/g,
    validate: (m) => /[\d+/=]/.test(m.slice(6)),
  },
  { name: 'stripe_like_key', type: 'api_key', pattern: /\b(?:sk|pk|rk)_(?:test|live)_[A-Za-z0-9]{10,}\b/g },
  { name: 'github_token', type: 'api_key', pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { name: 'google_api_key', type: 'api_key', pattern: /\bAIza[0-9A-Za-z_-]{30,}/g },
  { name: 'jwt', type: 'api_key', pattern: /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g },
  { name: 'bearer_token', type: 'api_key', pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{10,}=*/gi },
  {
    // Long random-looking string with letters AND digits (generic secret)
    name: 'high_entropy_token',
    type: 'api_key',
    pattern: /[A-Za-z0-9_\-+/=]{20,}/g,
    validate: (m) => /[A-Za-z]/.test(m) && /\d/.test(m) && entropy(m) >= 3.5,
  },
  {
    // "password=abc", "API_KEY: xyz", "token:xyz" written as one piece of text.
    name: 'key_value_secret',
    type: (m) => (/pass|pwd/i.test(m) ? 'password' : 'api_key'),
    // Optional prefix covers env-style names: DB_PASSWORD=, AWS_SECRET_ACCESS_KEY=
    pattern: /\b(?:[A-Za-z0-9]+[_.-])*(?:pass(?:word|wd|code|phrase)?|pwd|secret(?:[_-]?(?:access[_-]?)?key)?|api[_-]?(?:key|secret|token)|(?:access|auth|refresh|session|id|bearer)?[_-]?token|access[_-]?key(?:[_-]?id)?|account[_-]?key|private[_-]?key|client[_-]?secret|app[_-]?secret|signing[_-]?secret|connection[_-]?string|credentials?)\s*[:=]\s*\S+/gi,
  },
];

/**
 * Run all regex rules on every OCR line.
 * @returns [{ rule, type, words: [word...], score }]
 */
export function findRegexMatches(lines, rules = REGEX_RULES) {
  const hits = [];
  for (const line of lines) {
    for (const rule of rules) {
      rule.pattern.lastIndex = 0;
      for (const m of line.text.matchAll(rule.pattern)) {
        // valueGroup: mask only that capture group (the value), not the label before it
        const raw = rule.valueGroup ? m[rule.valueGroup] : m[0];
        if (!raw) continue;
        const text = raw.trim();
        if (rule.validate && !rule.validate(text)) continue;
        const start = rule.valueGroup ? m.index + m[0].lastIndexOf(raw) : m.index;
        const end = start + raw.length;
        const words = line.words.filter((w) => w.start < end && w.end > start);
        if (!words.length) continue;
        const type = typeof rule.type === 'function' ? rule.type(text) : rule.type;
        hits.push({ rule: rule.name, type, words, score: 1 });
      }
    }
  }
  return hits;
}
