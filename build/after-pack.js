// Ad-hoc signs the macOS app after packaging.
// Apple Silicon Macs refuse to open unsigned apps ("is damaged"), and we have no paid
// Apple Developer certificate, so we apply a free local ("ad-hoc") signature instead.
const { execSync } = require('child_process');
const path = require('path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);
  console.log(`  • ad-hoc signing ${appPath}`);
  execSync(`codesign --force --deep --sign - "${appPath}"`, { stdio: 'inherit' });
};
