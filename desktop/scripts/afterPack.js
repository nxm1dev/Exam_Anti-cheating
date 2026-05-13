const { rcedit } = require('rcedit');
const path = require('path');
const fs = require('fs');

exports.default = async function(context) {
  if (context.electronPlatformName !== 'win32') return;
  
  const exeName = context.packager.appInfo.productFilename + '.exe';
  const exePath = path.join(context.appOutDir, exeName);
  const iconPath = path.join(context.packager.projectDir, 'build', 'icon.ico');
  
  // Also try assets/icon.ico just in case
  const fallbackIconPath = path.join(context.packager.projectDir, 'assets', 'icon.ico');
  const finalIconPath = fs.existsSync(iconPath) ? iconPath : fallbackIconPath;

  console.log(`[afterPack] Setting icon for ${exePath} using ${finalIconPath}`);
  
  try {
    await rcedit(exePath, {
      icon: finalIconPath
    });
    console.log('[afterPack] Icon successfully injected!');
  } catch (err) {
    console.error('[afterPack] Failed to inject icon:', err);
  }
};
