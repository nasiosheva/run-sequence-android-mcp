import path from "node:path";
import { existsSync } from "node:fs";
import { execFileSync, spawn, ChildProcess } from "node:child_process";

const EXEC_TIMEOUT = 30000;
const MAX_BUFFER_SIZE = 1024 * 1024 * 16;

/** Error whose message is meant to be shown to the agent so it can self-correct. */
export class ActionableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ActionableError";
	}
}

export const getAdbPath = (): string => {
	const exeName = process.platform === "win32" ? "adb.exe" : "adb";

	if (process.env.ANDROID_HOME) {
		const p = path.join(process.env.ANDROID_HOME, "platform-tools", exeName);
		if (existsSync(p)) {
			return p;
		}
	}

	if (process.platform === "darwin" && process.env.HOME) {
		const p = path.join(process.env.HOME, "Library", "Android", "sdk", "platform-tools", "adb");
		if (existsSync(p)) {
			return p;
		}
	}

	if (process.platform === "win32" && process.env.LOCALAPPDATA) {
		const p = path.join(process.env.LOCALAPPDATA, "Android", "Sdk", "platform-tools", "adb.exe");
		if (existsSync(p)) {
			return p;
		}
	}

	return exeName;
};

const rawAdb = (args: string[]): Buffer => {
	try {
		return execFileSync(getAdbPath(), args, {
			maxBuffer: MAX_BUFFER_SIZE,
			timeout: EXEC_TIMEOUT,
			stdio: ["pipe", "pipe", "pipe"],
		});
	} catch (error: any) {
		if (error.code === "ENOENT") {
			throw new ActionableError("adb not found. Install Android platform-tools or set ANDROID_HOME.");
		}
		const stdout = error.stdout ? error.stdout.toString() : "";
		const stderr = error.stderr ? error.stderr.toString() : "";
		const output = (stdout + stderr).trim();
		throw new ActionableError(output || error.message);
	}
};

export interface AndroidDevice {
	id: string;
	name: string;
	androidVersion: string;
	connection: "usb" | "wifi" | "emulator";
	state: string;
}

const deviceConnection = (id: string): AndroidDevice["connection"] => {
	if (id.startsWith("emulator-")) {
		return "emulator";
	}
	// host:port targets and mDNS ADB-over-TLS serials are wireless
	if (id.includes(":") || id.includes("_adb-tls-connect") || id.includes("_adb_secure_connect")) {
		return "wifi";
	}
	return "usb";
};

const listRawDevices = (): Array<{ id: string; state: string }> => {
	return rawAdb(["devices"])
		.toString()
		.split("\n")
		.map(line => line.trim())
		.filter(line => line !== "" && !line.startsWith("List of devices attached") && !line.startsWith("*"))
		.map(line => {
			const parts = line.includes("\t") ? line.split("\t") : line.split(/\s+/);
			return { id: parts[0].trim(), state: (parts[1] || "unknown").trim() };
		})
		.filter(d => d.id !== "");
};

/** Auto-connect ADB-over-TLS peers advertised via mDNS (Android 11+ wireless debugging). */
const connectMdnsTlsPeers = (): void => {
	try {
		const mdns = rawAdb(["mdns", "services"]).toString();
		for (const line of mdns.split("\n").slice(1)) {
			if (!line.includes("_adb-tls-connect")) {
				continue;
			}
			const parts = line.trim().split(/\s+/);
			const ipPort = parts[parts.length - 1];
			if (ipPort && ipPort.includes(":")) {
				try {
					rawAdb(["connect", ipPort]);
				} catch {
					// peer not reachable, skip
				}
			}
		}
	} catch {
		// mDNS not available -- not an error
	}
};

export class AdbClient {

	public adb(deviceId: string, ...args: string[]): Buffer {
		return rawAdb(["-s", deviceId, ...args]);
	}

	public shell(deviceId: string, ...args: string[]): string {
		return this.adb(deviceId, "shell", ...args).toString();
	}

	public spawnAdb(deviceId: string, ...args: string[]): ChildProcess {
		return spawn(getAdbPath(), ["-s", deviceId, ...args], {
			stdio: ["ignore", "pipe", "pipe"],
		});
	}

	public listDevices(): AndroidDevice[] {
		let devices = listRawDevices();
		if (devices.length === 0) {
			connectMdnsTlsPeers();
			devices = listRawDevices();
		}

		return devices.map(d => {
			let name = d.id;
			let androidVersion = "unknown";
			if (d.state === "device") {
				name = this.getDeviceName(d.id);
				androidVersion = this.getProp(d.id, "ro.build.version.release") || "unknown";
			}
			return {
				id: d.id,
				name,
				androidVersion,
				connection: deviceConnection(d.id),
				state: d.state,
			};
		});
	}

	public getProp(deviceId: string, prop: string): string {
		try {
			return execFileSync(getAdbPath(), ["-s", deviceId, "shell", "getprop", prop], {
				timeout: 5000,
			}).toString().trim();
		} catch {
			return "";
		}
	}

	private getDeviceName(deviceId: string): string {
		const avdName = this.getProp(deviceId, "ro.boot.qemu.avd_name");
		if (avdName !== "") {
			return avdName.replace(/_/g, " ");
		}
		return this.getProp(deviceId, "ro.product.model") || deviceId;
	}

	/** Normalize a WiFi target: append default port 5555 when missing. */
	public normalizeWifiTarget(host: string): string {
		const trimmed = host.trim();
		if (trimmed === "") {
			throw new ActionableError("WiFi host must not be empty. Provide HOST or HOST:PORT.");
		}
		return trimmed.includes(":") ? trimmed : `${trimmed}:5555`;
	}

	public connectWifi(host: string): string {
		const target = this.normalizeWifiTarget(host);
		const output = rawAdb(["connect", target]).toString().trim();
		if (output.includes("failed") || output.includes("cannot")) {
			throw new ActionableError(
				`${output}. Ensure wireless debugging is enabled on the device and it is reachable on the network.`
			);
		}
		return output;
	}

	public disconnectWifi(host?: string): string {
		const args = host ? ["disconnect", this.normalizeWifiTarget(host)] : ["disconnect"];
		return rawAdb(args).toString().trim();
	}

	/**
	 * Resolve which device a tool call should target:
	 * explicit id -> ANDROID_MCP_DEVICE env -> the only online device ->
	 * first physical device (USB/WiFi preferred over emulators).
	 */
	public resolveDevice(explicit?: string): string {
		if (explicit && explicit.trim() !== "") {
			return explicit.trim();
		}

		const envDevice = (process.env.ANDROID_MCP_DEVICE || "").trim();
		if (envDevice !== "") {
			return envDevice;
		}

		const online = this.listDevices().filter(d => d.state === "device");
		if (online.length === 0) {
			throw new ActionableError(
				"No Android devices connected. Connect a device via USB (with USB debugging enabled), " +
					"start an emulator, or use android_connect_wifi for wireless debugging."
			);
		}
		if (online.length === 1) {
			return online[0].id;
		}

		const physical = online.find(d => d.connection !== "emulator");
		if (physical) {
			return physical.id;
		}
		return online[0].id;
	}

	public getScreenSize(deviceId: string): { width: number; height: number } {
		const raw = this.shell(deviceId, "wm", "size");
		// prefer override size when present, else physical size
		const override = raw.match(/Override size:\s*(\d+)x(\d+)/);
		const physical = raw.match(/Physical size:\s*(\d+)x(\d+)/);
		const m = override || physical;
		if (!m) {
			throw new ActionableError(`Failed to read screen size from: ${raw.trim()}`);
		}
		return { width: Number(m[1]), height: Number(m[2]) };
	}

	public getOrientation(deviceId: string): "portrait" | "landscape" {
		const rotation = this.shell(deviceId, "settings", "get", "system", "user_rotation").trim();
		return rotation === "0" || rotation === "2" || rotation === "null" ? "portrait" : "landscape";
	}

	public getCurrentApp(deviceId: string): { packageName: string; activity: string } {
		// "ResumedActivity" matches both the old "mResumedActivity:" and the
		// Android 13+ "ResumedActivity:" dumpsys formats
		const dump = this.shell(deviceId, "dumpsys", "activity", "activities");
		let m = dump.match(/ResumedActivity[^\n]*?\su\d+\s([a-zA-Z0-9_.]+)\/([a-zA-Z0-9_.$]+)/);
		if (m) {
			return { packageName: m[1], activity: m[2] };
		}
		// fallback: focused app from the window manager
		const windowDump = this.shell(deviceId, "dumpsys", "window");
		m = windowDump.match(/mFocusedApp[^\n]*?\su\d+\s([a-zA-Z0-9_.]+)\/([a-zA-Z0-9_.$]+)/);
		if (m) {
			return { packageName: m[1], activity: m[2] };
		}
		return { packageName: "unknown", activity: "unknown" };
	}

	/** Escape text for `adb shell input text` and other single-token shell args. */
	public escapeShellText(text: string): string {
		return text.replace(/[\\'"` \t\n\r|&;()<>{}[\]$*?~#]/g, "\\$&");
	}

	public isAscii(text: string): boolean {
		// eslint-disable-next-line no-control-regex
		return /^[\x00-\x7F]*$/.test(text);
	}
}

export const validatePackageName = (packageName: string): void => {
	if (!/^[a-zA-Z0-9_.]+$/.test(packageName)) {
		throw new ActionableError(
			`Invalid package name "${packageName}". Package names may only contain letters, digits, dots and underscores.`
		);
	}
};
