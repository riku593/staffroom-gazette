/*
 * Ships the third-party PDF.js and Tesseract.js files (from ../public/vendor)
 * alongside the web part bundle, so they're included in the .sppkg and served
 * from the tenant's app catalogue / CDN. The web part loads them at runtime.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const VENDOR = path.join(__dirname, '..', '..', 'public', 'vendor');

function walk(dir, base = dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, base, out);
    else out.push({ full, rel: path.relative(base, full).split(path.sep).join('/') });
  }
  return out;
}

module.exports = function customize(webpackConfiguration, taskSession, heftConfiguration, webpack) {
  if (!fs.existsSync(VENDOR)) throw new Error(`Vendor files not found at ${VENDOR}`);
  const files = walk(VENDOR);

  class EmitVendorAssetsPlugin {
    apply(compiler) {
      compiler.hooks.thisCompilation.tap('EmitVendorAssetsPlugin', (compilation) => {
        compilation.hooks.processAssets.tap(
          { name: 'EmitVendorAssetsPlugin', stage: webpack.Compilation.PROCESS_ASSETS_STAGE_ADDITIONAL },
          () => {
            for (const f of files) {
              compilation.emitAsset(`vendor/${f.rel}`, new webpack.sources.RawSource(fs.readFileSync(f.full)));
            }
          },
        );
      });
    }
  }

  const configs = Array.isArray(webpackConfiguration) ? webpackConfiguration : [webpackConfiguration];
  configs[0].plugins = configs[0].plugins || [];
  configs[0].plugins.push(new EmitVendorAssetsPlugin());
};
