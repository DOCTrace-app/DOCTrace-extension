// Checks that the JavaScript classifier gives the same probabilities as Python.
// Run from the project root:  node group2/tests/node/mlParity.test.mjs
import { readFileSync } from 'node:fs';
import { SensitiveClassifier, normalizeText } from '../../detection/mlClassifier.js';

const model = JSON.parse(readFileSync(new URL('../../model/sensitive_model.json', import.meta.url)));
const clf = new SensitiveClassifier(model);
const parity = clf.checkParity(1e-4);
console.log(`parity rows=${parity.rows} maxDiff=${parity.maxDiff.toExponential(2)}`);
for (const row of model.parity) {
  const js = clf.predict(row.text);
  console.log(`${row.prob.toFixed(4)} py | ${js.toFixed(4)} js | ${JSON.stringify(normalizeText(row.text))}`);
}
if (!parity.ok) {
  console.error('FAIL: JavaScript and Python scores differ');
  process.exit(1);
}
console.log('PASS: JavaScript model matches Python model');
