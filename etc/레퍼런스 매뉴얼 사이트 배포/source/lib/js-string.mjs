import assert from "node:assert/strict";

/** Decode the contents of a quoted JavaScript string without eval.
 * Google Sheets htmlview currently emits `\\xNN` escapes for punctuation,
 * while JSON.parse only accepts JSON escapes. Normalize that one syntax gap
 * before delegating the rest of the escaping rules to JSON.parse.
 */
export function decodeJsStringContent(value) {
  const jsonCompatible = String(value).replace(/\\x([0-9a-fA-F]{2})/g, "\\u00$1");
  return JSON.parse(`"${jsonCompatible}"`);
}

export function selfTest() {
  assert.equal(decodeJsStringContent("\\x5b참고용\\x5d"), "[참고용]");
  assert.equal(decodeJsStringContent('구_일본 \\"진행표\\"'), '구_일본 "진행표"');
  assert.equal(decodeJsStringContent("국내\\u0020진행표"), "국내 진행표");
}
