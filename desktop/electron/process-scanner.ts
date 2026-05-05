/**
 * electron/process-scanner.ts
 * ────────────────────────────
 * Periodically scans running processes and kills blacklisted applications.
 * Also provides VM / Sandbox detection (3-layer check).
 */

import { exec } from "child_process";
import { networkInterfaces } from "os";

// ── Blacklist ─────────────────────────────────────────────────────────

const BLACKLIST: string[] = [
  // Remote Desktop
  "TeamViewer",
  "TeamViewer_Service",
  "tv_w32",
  "tv_x64",
  "Ultraviewer",
  "Ultraviewer_desktop",
  "Ultraviewer_Service",
  "AnyDesk",
  "anydesk",
  "rustdesk",
  "RemoteDesktop",
  "mstsc",
  "LogMeIn",
  "vncserver",
  "vncviewer",
  "ammyy",

  // Video Call
  "Discord",
  "Zoom",
  "Skype",
  "Messenger",
  "ms-teams",
  "Teams",
  "Slack",
  "Webex",
  "CiscoCollabHost",
  "Lark",
  "Line",
  "Viber",
  "Zalo",
  "ZaloPC",
  "WhatsApp",
  "Telegram",

  // Screen Share / Record
  "obs64",
  "obs32",
  "obs",
  "Bandicam",
  "bdcam",
  "CamStudio",
  "ShareX",
  "ScreenRec",
  "Loom",
  "streamlabs",
  "XSplit",

  // Remote Support
  "SupRemo",
  "Splashtop",
  "SplashtopStreamer",
  "parsec",
  "Parsec",
];

// Normalize to lowercase set for fast lookup
const BLACKLIST_SET = new Set(BLACKLIST.map((name) => name.toLowerCase()));

// ── VM Detection Constants ────────────────────────────────────────────

const VM_PROCESSES = [
  // VMware
  "vmtoolsd",
  "vmwaretray",
  "vmwareuser",
  "vmware-vmx",
  // VirtualBox
  "vboxservice",
  "vboxclient",
  "vboxtray",
  "vboxsvc",
  // Hyper-V
  "vmms",
  "vmcompute",
  "vmwp",
  // QEMU
  "qemu-ga",
  "qemu-system",
  // Windows Sandbox
  "windowssandbox",
  "windowssandboxclient",
];

const VM_PROCESSES_SET = new Set(VM_PROCESSES.map((n) => n.toLowerCase()));

const VM_MAC_PREFIXES = [
  "00:0c:29", // VMware
  "00:50:56", // VMware
  "00:05:69", // VMware
  "08:00:27", // VirtualBox
  "00:15:5d", // Hyper-V
  "52:54:00", // QEMU/KVM
];

const VM_MANUFACTURER_KEYWORDS = [
  "vmware",
  "virtualbox",
  "qemu",
  "xen",
  "kvm",
  "microsoft corporation", // Hyper-V
  "innotek",
  "oracle",
  "parallels",
];

// ── Scanner State ─────────────────────────────────────────────────────

let scanInterval: NodeJS.Timeout | null = null;

type ProcessKilledCallback = (name: string) => void;

/**
 * Start periodic process scanning.
 * @param onProcessKilled Called each time a blacklisted process is killed.
 * @param intervalMs Scan interval (default 60 000 ms = 1 minute).
 */
export function startProcessScanner(
  onProcessKilled: ProcessKilledCallback,
  intervalMs = 60_000
): void {
  if (scanInterval) return;

  // Run once immediately
  scanAndKill(onProcessKilled);

  scanInterval = setInterval(() => {
    scanAndKill(onProcessKilled);
  }, intervalMs);

  console.log(`[ProcessScanner] Started (interval ${intervalMs}ms)`);
}

/**
 * Stop periodic process scanning.
 */
export function stopProcessScanner(): void {
  if (scanInterval) {
    clearInterval(scanInterval);
    scanInterval = null;
    console.log("[ProcessScanner] Stopped");
  }
}

/**
 * Scan currently running processes and kill any matching the blacklist.
 */
function scanAndKill(onProcessKilled: ProcessKilledCallback): void {
  // tasklist /FO CSV /NH outputs: "image_name.exe","PID","Session Name","Session#","Mem Usage"
  exec("tasklist /FO CSV /NH", { windowsHide: true }, (error, stdout) => {
    if (error) {
      console.error("[ProcessScanner] tasklist error:", error.message);
      return;
    }

    const lines = stdout.trim().split("\n");

    for (const line of lines) {
      // Extract process name from CSV format: "name.exe",...
      const match = line.match(/^"([^"]+)"/);
      if (!match) continue;

      const fullName = match[1]; // e.g. "Discord.exe"
      const baseName = fullName.replace(/\.exe$/i, "").toLowerCase();

      if (BLACKLIST_SET.has(baseName)) {
        killProcess(fullName, onProcessKilled);
      }
    }
  });
}

/**
 * Force-kill a process by image name.
 */
function killProcess(imageName: string, onKilled: ProcessKilledCallback): void {
  exec(
    `taskkill /IM "${imageName}" /F`,
    { windowsHide: true },
    (error, _stdout, stderr) => {
      if (error) {
        // Process may have already exited
        if (!stderr?.includes("not found")) {
          console.warn(`[ProcessScanner] Failed to kill ${imageName}:`, stderr);
        }
        return;
      }

      console.log(`[ProcessScanner] Killed: ${imageName}`);
      onKilled(imageName.replace(/\.exe$/i, ""));
    }
  );
}

// ── VM Detection ──────────────────────────────────────────────────────

export interface VMDetectionResult {
  isVM: boolean;
  indicators: string[];
}

/**
 * Detect if the current machine is a virtual machine (3-layer check).
 */
export async function detectVirtualMachine(): Promise<VMDetectionResult> {
  const indicators: string[] = [];

  // Layer 1: Check VM processes
  const vmProcesses = await checkVMProcesses();
  indicators.push(...vmProcesses);

  // Layer 2: Check MAC addresses
  const vmMacs = checkVMMacAddresses();
  indicators.push(...vmMacs);

  // Layer 3: Check system manufacturer
  const vmManufacturer = await checkSystemManufacturer();
  indicators.push(...vmManufacturer);

  return {
    isVM: indicators.length > 0,
    indicators,
  };
}

function checkVMProcesses(): Promise<string[]> {
  return new Promise((resolve) => {
    exec("tasklist /FO CSV /NH", { windowsHide: true }, (error, stdout) => {
      if (error) {
        resolve([]);
        return;
      }

      const found: string[] = [];
      const lines = stdout.trim().split("\n");

      for (const line of lines) {
        const match = line.match(/^"([^"]+)"/);
        if (!match) continue;

        const baseName = match[1].replace(/\.exe$/i, "").toLowerCase();
        if (VM_PROCESSES_SET.has(baseName)) {
          found.push(`VM process detected: ${match[1]}`);
        }
      }

      resolve(found);
    });
  });
}

function checkVMMacAddresses(): string[] {
  const found: string[] = [];
  const ifaces = networkInterfaces();

  for (const [_name, addrs] of Object.entries(ifaces)) {
    if (!addrs) continue;

    for (const addr of addrs) {
      if (addr.internal || !addr.mac || addr.mac === "00:00:00:00:00:00") {
        continue;
      }

      const macLower = addr.mac.toLowerCase();
      for (const prefix of VM_MAC_PREFIXES) {
        if (macLower.startsWith(prefix)) {
          found.push(`VM MAC address: ${addr.mac} (prefix ${prefix})`);
        }
      }
    }
  }

  return found;
}

function checkSystemManufacturer(): Promise<string[]> {
  return new Promise((resolve) => {
    exec(
      "wmic computersystem get manufacturer,model /format:csv",
      { windowsHide: true },
      (error, stdout) => {
        if (error) {
          resolve([]);
          return;
        }

        const found: string[] = [];
        const lower = stdout.toLowerCase();

        for (const keyword of VM_MANUFACTURER_KEYWORDS) {
          if (lower.includes(keyword)) {
            found.push(`VM manufacturer/model contains: "${keyword}"`);
          }
        }

        resolve(found);
      }
    );
  });
}
