// Vendor the OFL fonts from local copies without a network connection.
// Usage: node tools/vendor-fonts.mjs <Instrument Sans assets> <Source Serif 4 assets>
// The Instrument folder contains the 400–700 variable WOFF2 and its OFL text.
// The Source folder contains Adobe's regular, semibold and italic fonts in WOFF2 format and OFL text.
// If the originals are TTF, convert with fonttools ttLib.woff2 compress.
import { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const [instrument, source] = process.argv.slice(2);
if (!instrument || !source) {
  console.error('Usage: node tools/vendor-fonts.mjs <Instrument Sans assets> <Source Serif 4 assets>');
  process.exit(1);
}

const fonts = [
  [instrument, 'instrument-sans.woff2', 'Instrument Sans', 'normal', '400 700', 'woff2'],
  [source, 'SourceSerif4-Regular.woff2', 'Source Serif 4', 'normal', '400', 'woff2'],
  [source, 'SourceSerif4-SemiBold.woff2', 'Source Serif 4', 'normal', '600', 'woff2'],
  [source, 'SourceSerif4-Italic.woff2', 'Source Serif 4', 'italic', '500', 'woff2'],
];
const licenses = [
  [instrument, 'OFL-instrument-sans.txt', 'OFL-InstrumentSans.txt'],
  [source, 'OFL-SourceSerif4.txt', 'OFL-SourceSerif4.txt'],
];
// Size adjustments use the relative widths of representative desk copy.
// Vertical overrides use each vendored face's ascent and descent after sizing.
const fallback = [
  ['Instrument Sans', 'Arial', 'normal', '400 500', 101.68, 95.40, 24.59],
  ['Instrument Sans', 'Arial Bold', 'normal', '600 700', 97.40, 99.59, 25.67],
  ['Source Serif 4', 'Georgia', 'normal', '400', 105.19, 98.49, 31.85],
  ['Source Serif 4', 'Georgia Bold', 'normal', '600 700', 93.91, 110.31, 35.67],
  ['Source Serif 4', 'Georgia Italic', 'italic', '500', 97.56, 106.19, 34.34],
].map(([family, local, style, weight, size, ascent, descent]) => `@font-face {
  font-family: '${family} Fallback';
  font-style: ${style};
  font-weight: ${weight};
  src: local('${local}');
  size-adjust: ${size}%;
  ascent-override: ${ascent}%;
  descent-override: ${descent}%;
  line-gap-override: 0%;
}`);
const dir = new URL('../static/fonts/', import.meta.url);
mkdirSync(dir, { recursive: true });

const assets = fonts.map(([from, file, family, style, weight, format]) => {
  const bytes = readFileSync(join(from, file));
  const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 12);
  const name = file.replace(/(\.[^.]+)$/, `-${hash}$1`).toLowerCase();
  const css = `@font-face {
  font-family: '${family}';
  font-style: ${style};
  font-weight: ${weight};
  font-display: swap;
  src: url(fonts/${name}) format('${format}');
}`;
  return { bytes, name, css };
});
const licenseFiles = licenses.map(([from, file, name]) => ({ bytes: readFileSync(join(from, file)), name }));

for (const { bytes, name } of [...assets, ...licenseFiles]) writeFileSync(new URL(name, dir), bytes);
writeFileSync(new URL('fonts.css', dir), `/* Vendored OFL fonts. See OFL-InstrumentSans.txt and OFL-SourceSerif4.txt. */\n${[...assets.map(({ css }) => css), ...fallback].join('\n')}\n`);
const used = new Set(assets.map(({ name }) => name));
for (const file of readdirSync(dir)) {
  if (file.endsWith('.woff2') && !used.has(file)) unlinkSync(new URL(file, dir));
}
console.log(assets.map(({ name, bytes }) => `${name} ${bytes.length}`).join('\n'));
