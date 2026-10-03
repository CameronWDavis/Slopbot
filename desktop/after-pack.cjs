// electron-builder afterPack hook. When building without a Developer ID certificate (e.g. CI
// with no signing secrets), give the macOS app an ad-hoc signature. Without any valid signature,
// Apple Silicon reports a downloaded app as "damaged"; ad-hoc signed, it shows the normal
// "unidentified developer" prompt that users can approve.
const { execFileSync } = require("node:child_process");
const path = require("node:path");

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  const realSigning = process.env.CSC_LINK || process.env.CSC_IDENTITY_AUTO_DISCOVERY !== "false";
  if (realSigning) return; // electron-builder signs with the real identity afterwards
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  console.log(`  • ad-hoc signing ${path.basename(app)} (no Developer ID certificate configured)`);
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", app], { stdio: "inherit" });
};
