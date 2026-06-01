/**
 * electron-builder afterSign hook: notarize the macOS app with Apple.
 *
 * Runs after electron-builder code-signs the .app. Notarization is what lets
 * Gatekeeper open the app without the "unidentified developer" warning.
 *
 * Gated on credentials: if APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD /
 * APPLE_TEAM_ID aren't all present, we skip with a warning instead of failing.
 * That keeps local/dev builds and unsigned CI builds working — the release
 * pipeline supplies the secrets when they exist.
 *
 * Only runs on macOS targets; a no-op for win/linux.
 *
 * Required env for real notarization:
 *   APPLE_ID                     Apple developer account email
 *   APPLE_APP_SPECIFIC_PASSWORD  app-specific password (appleid.apple.com)
 *   APPLE_TEAM_ID                10-char team id
 */
exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== 'darwin') return;

  const { APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID } = process.env;
  if (!APPLE_ID || !APPLE_APP_SPECIFIC_PASSWORD || !APPLE_TEAM_ID) {
    console.warn(
      '[notarize] skipping — APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID not all set. ' +
      'The build is signed but NOT notarized; Gatekeeper will warn on first launch.',
    );
    return;
  }

  // Lazy-require so the dependency is only needed when actually notarizing.
  let notarize;
  try {
    ({ notarize } = require('@electron/notarize'));
  } catch (e) {
    console.warn('[notarize] @electron/notarize not installed — skipping notarization.');
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = `${appOutDir}/${appName}.app`;

  console.log(`[notarize] submitting ${appName}.app to Apple (this can take a few minutes)…`);
  await notarize({
    appPath,
    appleId: APPLE_ID,
    appleIdPassword: APPLE_APP_SPECIFIC_PASSWORD,
    teamId: APPLE_TEAM_ID,
  });
  console.log('[notarize] done.');
};
