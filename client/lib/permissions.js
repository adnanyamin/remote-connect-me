/**
 * Platform-specific permission helpers for the Electron host.
 *
 * Windows: no prompts required.
 * macOS:   Screen Recording + Accessibility (for synthetic input).
 *          We can only *prompt* the user; granting requires them to flip the
 *          switch in System Settings -> Privacy and restart the app.
 * Linux:   PipeWire (Wayland) needs a portal; X11 just works. We detect and warn.
 */

const { systemPreferences } = require('electron');

function isMac() { return process.platform === 'darwin'; }
function isLinux() { return process.platform === 'linux'; }
function isWayland() {
  return isLinux() && (process.env.XDG_SESSION_TYPE === 'wayland' || !!process.env.WAYLAND_DISPLAY);
}

/**
 * Check Screen Recording permission. On macOS pre-10.15 this is always granted.
 * On Catalina+ the user must explicitly allow it; calling getMediaAccessStatus
 * does not prompt — we have to actually try capture for the prompt to appear.
 * Returns one of 'not-determined' | 'granted' | 'denied' | 'restricted' | 'unknown'.
 */
function screenStatus() {
  if (!isMac()) return 'granted';
  try { return systemPreferences.getMediaAccessStatus('screen'); }
  catch { return 'unknown'; }
}

/**
 * Accessibility (synthetic mouse / keyboard) gate on macOS. Passing `prompt = true`
 * shows the Add-to-Accessibility dialog the first time it's called.
 */
function accessibilityStatus(prompt = false) {
  if (!isMac()) return true;
  try { return systemPreferences.isTrustedAccessibilityClient(prompt); }
  catch { return false; }
}

function summary() {
  return {
    platform: process.platform,
    arch: process.arch,
    screen: screenStatus(),
    accessibility: accessibilityStatus(false),
    wayland: isWayland(),
  };
}

function logWarnings(logFn = console.warn) {
  const s = summary();
  if (s.wayland) {
    logFn('[permissions] Wayland session detected. Electron desktopCapturer ' +
      'works via the xdg-desktop-portal screencast; synthetic input via ' +
      'nut-js needs uinput (`sudo modprobe uinput` + udev rules).');
  }
  if (isMac()) {
    if (s.screen !== 'granted') {
      logFn(`[permissions] Screen Recording status: ${s.screen}. ` +
        'Grant RemoteConnectMe access in System Settings -> Privacy & Security -> Screen Recording, then restart.');
    }
    if (!s.accessibility) {
      logFn('[permissions] Accessibility access not granted. Synthetic mouse/keyboard ' +
        'injection will be a no-op until you add RemoteConnectMe under ' +
        'System Settings -> Privacy & Security -> Accessibility.');
    }
  }
}

/**
 * Trigger the permission prompts on first launch. Safe to call repeatedly —
 * macOS only shows each prompt once until the user resets via tccutil.
 */
async function requestAll() {
  if (isMac()) {
    // Show Accessibility dialog on first launch.
    accessibilityStatus(true);
    // There is no API to programmatically prompt Screen Recording; the first
    // call to desktopCapturer.getSources() will trigger the OS prompt itself.
    // Just log so the user knows what's coming.
  }
  logWarnings();
}

module.exports = { summary, screenStatus, accessibilityStatus, isWayland, requestAll };
