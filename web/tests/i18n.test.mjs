// Languages: detection, dictation tags, and that every hand-written translation matches the English keys.
import assert from "node:assert/strict";
import { test } from "node:test";
import { LANGUAGES, detectLanguage, speechTag } from "../src/i18n/languages.ts";
import { en } from "../src/i18n/en.ts";

const placeholders = (s) => (s.match(/\{\w+\}/g) ?? []).sort();
const numbers = (s) => (s.match(/\d+(?:\.\d+)?/g) ?? []).sort();

test("detects the first supported browser language", () => {
  assert.equal(detectLanguage(["hi-IN", "en-US"]), "hi");
  assert.equal(detectLanguage(["xx-YY", "ta-IN"]), "ta");
  assert.equal(detectLanguage(["en-IN"]), "en");
  assert.equal(detectLanguage(["xx"]), "en");
  assert.equal(detectLanguage([]), "en");
});

test("dictation keeps the browser's English variant and uses Indian tags for Indian languages", () => {
  assert.equal(speechTag("en", ["en-GB"]), "en-GB");
  assert.equal(speechTag("en", ["hi-IN"]), "en-IN");
  assert.equal(speechTag("te", ["en-US"]), "te-IN");
  assert.equal(speechTag("hi", ["hi-IN"]), "hi-IN");
});

for (const lang of LANGUAGES.filter((l) => l.code !== "en")) {
  test(`${lang.english}: hand-written keys exist in English and keep placeholders and numbers`, async () => {
    const table = (await import(`../src/i18n/locales/${lang.code}.ts`)).default;
    const keys = Object.keys(table);
    assert.ok(keys.length >= 60, `${lang.code} has only ${keys.length} hand-written strings`);
    for (const k of keys) {
      assert.ok(k in en, `${lang.code}: unknown key ${k}`);
      assert.deepEqual(placeholders(table[k]), placeholders(en[k]), `${lang.code} ${k}: placeholders`);
      assert.deepEqual(numbers(table[k]), numbers(en[k]), `${lang.code} ${k}: numbers`);
    }
    // the safety text is never left to machine translation
    for (const k of ["start.notice.stop", "start.notice.limits", "call.hazardMessage", "call.alert.stop", "call.precaution.unplugged"]) {
      assert.ok(table[k], `${lang.code}: missing safety text ${k}`);
    }
  });
}
