// Windows integration: desktop shortcut and "Start with Windows" (a shortcut in the user's Startup folder).
import { execFile } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { ROOT } from "./db.mjs";

const LAUNCH = path.join(ROOT, "scripts", "launch.ps1");
const ICON = path.join(ROOT, "public", "icon.ico");
const startupLink = () => path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "SEO Auditor.lnk");

function ps(script, env) {
  return new Promise((resolve, reject) => execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script],
    { env: { ...process.env, ...env }, windowsHide: true, timeout: 30000 }, (err, out, errOut) => (err ? reject(new Error(errOut || err.message)) : resolve(out.trim()))));
}

/** Creates a .lnk that runs launch.ps1 hidden. Paths travel in env vars, never spliced into the script. */
export function makeShortcut(linkPath, extraArgs = "") {
  return ps(`$s=(New-Object -ComObject WScript.Shell).CreateShortcut($env:SA_LINK); $s.TargetPath="$env:SystemRoot\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
$s.Arguments='-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $env:SA_LAUNCH + '"' + $env:SA_ARGS; $s.WorkingDirectory=$env:SA_ROOT;
$s.IconLocation=$env:SA_ICON; $s.Description='SEO Auditor'; $s.WindowStyle=7; $s.Save()`,
  { SA_LINK: linkPath, SA_LAUNCH: LAUNCH, SA_ARGS: extraArgs, SA_ROOT: ROOT, SA_ICON: ICON });
}

export async function desktopPath() { return ps("[Environment]::GetFolderPath('Desktop')"); }
export async function installDesktopShortcut() { const link = path.join(await desktopPath(), "SEO Auditor.lnk"); await makeShortcut(link); return link; }
export const autostartEnabled = () => existsSync(startupLink());
export async function setAutostart(on) {
  if (on) await makeShortcut(startupLink(), " -NoBrowser");
  else if (existsSync(startupLink())) unlinkSync(startupLink());
  return autostartEnabled();
}

export function register({ routes }) {
  routes.push(["GET", /^\/api\/autostart$/, () => ({ enabled: autostartEnabled(), supported: process.platform === "win32" })]);
  routes.push(["PUT", /^\/api\/autostart$/, async (p, q, b) => ({ enabled: await setAutostart(Boolean(b.enabled)) })]);
}
