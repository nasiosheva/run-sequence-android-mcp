import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChildProcess } from "node:child_process";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { AdbClient, ActionableError, validatePackageName } from "./adb.js";
import { UiInspector, ElementSelector, elementCenter } from "./ui.js";

const SERVER_VERSION = "1.0.0";
const ALLOWED_SCREENSHOT_EXTENSIONS = [".png"];
const ALLOWED_RECORDING_EXTENSIONS = [".mp4"];
const MAX_RECORDING_SECONDS = 180; // hard limit of android screenrecord

const KEYCODE_ALIASES: Record<string, string> = {
	BACK: "KEYCODE_BACK",
	HOME: "KEYCODE_HOME",
	MENU: "KEYCODE_MENU",
	ENTER: "KEYCODE_ENTER",
	DELETE: "KEYCODE_DEL",
	DEL: "KEYCODE_DEL",
	TAB: "KEYCODE_TAB",
	SPACE: "KEYCODE_SPACE",
	ESCAPE: "KEYCODE_ESCAPE",
	POWER: "KEYCODE_POWER",
	APP_SWITCH: "KEYCODE_APP_SWITCH",
	VOLUME_UP: "KEYCODE_VOLUME_UP",
	VOLUME_DOWN: "KEYCODE_VOLUME_DOWN",
	VOLUME_MUTE: "KEYCODE_VOLUME_MUTE",
	DPAD_UP: "KEYCODE_DPAD_UP",
	DPAD_DOWN: "KEYCODE_DPAD_DOWN",
	DPAD_LEFT: "KEYCODE_DPAD_LEFT",
	DPAD_RIGHT: "KEYCODE_DPAD_RIGHT",
	DPAD_CENTER: "KEYCODE_DPAD_CENTER",
};

interface ActiveRecording {
	process: ChildProcess;
	devicePath: string;
	startedAt: number;
}

const validateFileExtension = (filePath: string, allowed: string[]): void => {
	const ext = path.extname(filePath).toLowerCase();
	if (!allowed.includes(ext)) {
		throw new ActionableError(`File extension "${ext}" is not allowed. Use one of: ${allowed.join(", ")}`);
	}
};

const validateOutputPath = (filePath: string): void => {
	if (!path.isAbsolute(filePath)) {
		throw new ActionableError(`Output path must be absolute, got "${filePath}"`);
	}
	const dir = path.dirname(filePath);
	if (!fs.existsSync(dir)) {
		throw new ActionableError(`Directory "${dir}" does not exist. Create it first or use another path.`);
	}
};

export const createServer = (): McpServer => {
	const server = new McpServer({
		name: "run-sequence-android-mcp",
		version: SERVER_VERSION,
	});

	const adb = new AdbClient();
	const ui = new UiInspector(adb);
	const activeRecordings = new Map<string, ActiveRecording>();

	type ZodShape = Record<string, z.ZodType>;

	interface Annotations {
		readOnlyHint?: boolean;
		destructiveHint?: boolean;
		idempotentHint?: boolean;
	}

	const tool = (
		name: string,
		title: string,
		description: string,
		schema: ZodShape,
		annotations: Annotations,
		cb: (args: any) => Promise<string>
	): void => {
		server.registerTool(
			name,
			{ title, description, inputSchema: schema, annotations },
			(async (args: any) => {
				try {
					const response = await cb(args);
					return { content: [{ type: "text", text: response }] };
				} catch (error: any) {
					if (error instanceof ActionableError) {
						return {
							content: [{ type: "text", text: `${error.message}` }],
						};
					}
					return {
						content: [{ type: "text", text: `Error: ${error.message}` }],
						isError: true,
					};
				}
			}) as any
		);
	};

	const deviceParam = z
		.string()
		.optional()
		.describe(
			"Device id (serial or host:port). Optional -- when omitted, uses ANDROID_MCP_DEVICE env or auto-selects the connected device (physical devices preferred over emulators)."
		);

	const selectorParams: ZodShape = {
		text: z.string().optional().describe("Match by exact visible text"),
		textContains: z.string().optional().describe("Match by substring of visible text (case-insensitive)"),
		resourceId: z
			.string()
			.optional()
			.describe("Match by resource id. Short ids like 'btn_login' are auto-expanded using the foreground app package"),
		contentDesc: z.string().optional().describe("Match by accessibility label / content description (substring, case-insensitive)"),
		className: z.string().optional().describe("Match by class name, e.g. 'android.widget.Button' or just 'Button'"),
	};

	const requireSelector = (selector: ElementSelector): void => {
		if (!ui.hasAnySelector(selector)) {
			throw new ActionableError(
				"At least one selector is required: text, textContains, resourceId, contentDesc, or className."
			);
		}
	};

	const coordinate = z.number().int().min(0).max(32767);
	const clearField = (id: string): void => {
		const field = ui.getElements(id).find(el => el.focused && el.type === "android.widget.EditText");
		if (!field) throw new ActionableError("Cannot clear: no accessible focused text field found.");
		const value = field.text === field.label ? "" : (field.text ?? "");
		if (value.length > 1000) throw new ActionableError("Cannot clear a field longer than 1000 characters.");
		if (value.length) {
			adb.shell(id, "input", "keyevent", "KEYCODE_MOVE_END", ...Array.from({ length: value.length }, () => "KEYCODE_DEL"));
		}
		const remaining = ui.getElements(id).find(el => el.focused && el.type === "android.widget.EditText");
		if (remaining?.text && remaining.text !== remaining.label) throw new ActionableError("Could not verify that the focused field is empty.");
	};
	const step = z.discriminatedUnion("action", [
		z.object({ action: z.literal("tap"), x: coordinate, y: coordinate }),
		z.object({ action: z.literal("swipe"), fromX: coordinate, fromY: coordinate, toX: coordinate, toY: coordinate, durationMs: z.number().int().min(1).max(10000) }),
		z.object({ action: z.literal("key"), key: z.enum(["BACK", "HOME", "ENTER", "TAB"]) }),
		z.object({ action: z.literal("wait"), durationMs: z.number().int().min(0).max(30000) }),
		z.object({ action: z.literal("text"), text: z.string().max(1000), clear: z.boolean().optional(), submit: z.boolean().optional() }),
		z.object({ action: z.literal("wait_for_element"), text: z.string().min(1).optional(), contentDesc: z.string().min(1).optional(), resourceId: z.string().min(1).optional(), timeoutMs: z.number().int().min(1).max(30000).optional() }),
	]);

	tool("run_sequence", "Run Android Sequence", "Run ordered Android actions, batching consecutive input commands in one ADB shell. Stops on errors; wait_for_element checks accessibility UI, not application success.",
		{ device: deviceParam, steps: z.array(step).min(1).max(100) }, {}, async ({ device, steps }) => {
			for (const s of steps) {
				if (s.action === "wait_for_element" && !s.text && !s.contentDesc && !s.resourceId) throw new Error("A selector is required for wait_for_element");
				if (s.action === "text" && !adb.isAscii(s.text)) throw new Error("Only ASCII text is supported");
			}
			const id = adb.resolveDevice(device);
			let commands: string[] = [];
			let batchStart = 0;
			const flush = () => {
				if (commands.length) {
					try { adb.shell(id, commands.join(" && ")); }
					catch (error: any) { throw new Error(`Sequence failed in batch starting at step ${batchStart + 1}: ${error.message}`); }
					commands = [];
				}
			};
			for (let i = 0; i < steps.length; i++) {
				const s = steps[i];
				if (s.action === "wait" || s.action === "text") {
					flush();
					try {
						if (s.action === "wait") await new Promise(resolve => setTimeout(resolve, s.durationMs));
						else {
							if (s.clear) clearField(id);
							if (s.text) adb.shell(id, "input", "text", adb.escapeShellText(s.text));
							if (s.submit) adb.shell(id, "input", "keyevent", "KEYCODE_ENTER");
						}
					} catch (error: any) { throw new Error(`Sequence failed at step ${i + 1}: ${error.message}`); }
					continue;
				}
				if (s.action === "wait_for_element") {
					flush();
					const found = await ui.waitForElement(id, { text: s.text, contentDesc: s.contentDesc, resourceId: s.resourceId }, s.timeoutMs ?? 10000);
					if (!found) throw new Error(`Sequence failed at step ${i + 1}: element not found`);
					continue;
				}
				if (!commands.length) batchStart = i;
				if (s.action === "tap") commands.push(`input tap ${s.x} ${s.y}`);
				else if (s.action === "swipe") commands.push(`input swipe ${s.fromX} ${s.fromY} ${s.toX} ${s.toY} ${s.durationMs}`);
				else if (s.action === "key") commands.push(`input keyevent KEYCODE_${s.key}`);
			}
			flush();
			return JSON.stringify({ device: id, completed: steps.length });
		});

	// ------------------------------------------------------------------
	// Device management
	// ------------------------------------------------------------------

	tool(
		"android_list_devices",
		"List Devices",
		"List connected Android devices and emulators with name, Android version, and connection type. Auto-discovers wireless-debugging devices via mDNS when the list is empty.",
		{},
		{ readOnlyHint: true },
		async () => {
			const devices = adb.listDevices();
			if (devices.length === 0) {
				return "No devices found. Connect a device via USB (with USB debugging enabled), start an emulator, or use android_connect_wifi.";
			}
			return JSON.stringify({ devices }, null, 2);
		}
	);

	tool(
		"android_connect_wifi",
		"Connect WiFi Device",
		"Connect to an Android device over WiFi ADB. Accepts HOST or HOST:PORT (port defaults to 5555). The device must have wireless debugging or 'adb tcpip 5555' enabled.",
		{
			host: z.string().describe("Device host, e.g. '192.168.1.3' or '192.168.1.3:5555'"),
		},
		{},
		async ({ host }) => {
			const output = adb.connectWifi(host);
			return output;
		}
	);

	tool(
		"android_device_info",
		"Device Info",
		"Get details of a device: model, Android version, SDK level, screen size, orientation, battery level, and the current foreground app.",
		{ device: deviceParam },
		{ readOnlyHint: true },
		async ({ device }) => {
			const id = adb.resolveDevice(device);
			const size = adb.getScreenSize(id);
			const current = adb.getCurrentApp(id);
			let batteryLevel = "unknown";
			try {
				const battery = adb.shell(id, "dumpsys", "battery");
				batteryLevel = battery.match(/level:\s*(\d+)/)?.[1] ?? "unknown";
			} catch {
				// battery info is optional
			}
			const info = {
				id,
				name: adb.getProp(id, "ro.product.model") || id,
				androidVersion: adb.getProp(id, "ro.build.version.release"),
				sdkLevel: adb.getProp(id, "ro.build.version.sdk"),
				screenSize: `${size.width}x${size.height}`,
				orientation: adb.getOrientation(id),
				batteryLevel,
				foregroundApp: current,
			};
			return JSON.stringify(info, null, 2);
		}
	);

	// ------------------------------------------------------------------
	// App management
	// ------------------------------------------------------------------

	tool(
		"android_list_apps",
		"List Apps",
		"List installed apps that have a launcher activity (package names).",
		{ device: deviceParam },
		{ readOnlyHint: true },
		async ({ device }) => {
			const id = adb.resolveDevice(device);
			const packages = adb
				.shell(id, "cmd", "package", "query-activities", "-a", "android.intent.action.MAIN", "-c", "android.intent.category.LAUNCHER")
				.split("\n")
				.map(line => line.trim())
				.filter(line => line.startsWith("packageName="))
				.map(line => line.substring("packageName=".length))
				.filter((value, index, self) => self.indexOf(value) === index)
				.sort();
			return JSON.stringify({ apps: packages }, null, 2);
		}
	);

	tool(
		"android_launch_app",
		"Launch App",
		"Launch an app by package name. Use android_list_apps to find package names.",
		{
			device: deviceParam,
			packageName: z.string().describe("Package name, e.g. 'com.android.settings'"),
		},
		{},
		async ({ device, packageName }) => {
			const id = adb.resolveDevice(device);
			validatePackageName(packageName);
			try {
				adb.shell(id, "monkey", "-p", packageName, "-c", "android.intent.category.LAUNCHER", "1");
			} catch {
				throw new ActionableError(
					`Failed to launch "${packageName}". Check that the app is installed with android_list_apps.`
				);
			}
			return `Launched app ${packageName}`;
		}
	);

	tool(
		"android_terminate_app",
		"Terminate App",
		"Force-stop a running app by package name.",
		{
			device: deviceParam,
			packageName: z.string().describe("Package name of the app to stop"),
		},
		{ destructiveHint: true },
		async ({ device, packageName }) => {
			const id = adb.resolveDevice(device);
			validatePackageName(packageName);
			adb.shell(id, "am", "force-stop", packageName);
			return `Terminated app ${packageName}`;
		}
	);

	tool(
		"android_install_app",
		"Install App",
		"Install an APK file on the device.",
		{
			device: deviceParam,
			apkPath: z.string().describe("Absolute path to the .apk file on this computer"),
			grantPermissions: z.boolean().optional().describe("Grant all runtime permissions at install time (useful for testing)"),
		},
		{},
		async ({ device, apkPath, grantPermissions }) => {
			const id = adb.resolveDevice(device);
			if (!fs.existsSync(apkPath)) {
				throw new ActionableError(`APK file not found at "${apkPath}"`);
			}
			const args = ["install", "-r"];
			if (grantPermissions) {
				args.push("-g");
			}
			args.push(apkPath);
			adb.adb(id, ...args);
			return `Installed app from ${apkPath}`;
		}
	);

	tool(
		"android_uninstall_app",
		"Uninstall App",
		"Uninstall an app from the device by package name.",
		{
			device: deviceParam,
			packageName: z.string().describe("Package name of the app to uninstall"),
		},
		{ destructiveHint: true },
		async ({ device, packageName }) => {
			const id = adb.resolveDevice(device);
			validatePackageName(packageName);
			adb.adb(id, "uninstall", packageName);
			return `Uninstalled app ${packageName}`;
		}
	);

	// ------------------------------------------------------------------
	// Screen observation
	// ------------------------------------------------------------------

	server.registerTool(
		"android_take_screenshot",
		{
			title: "Take Screenshot",
			description:
				"Take a screenshot of the device screen and return it as an image. Use android_list_elements first when you need coordinates of UI elements. Do not cache this result.",
			inputSchema: { device: deviceParam },
			annotations: { readOnlyHint: true },
		},
		(async ({ device }: { device?: string }) => {
			try {
				const id = adb.resolveDevice(device);
				const screenshot = adb.adb(id, "exec-out", "screencap", "-p");
				if (screenshot.length < 8 || screenshot[1] !== 0x50) {
					throw new ActionableError("Screenshot is not a valid PNG. Please try again.");
				}
				return {
					content: [{ type: "image", data: screenshot.toString("base64"), mimeType: "image/png" }],
				};
			} catch (error: any) {
				return {
					content: [{ type: "text", text: `Error: ${error.message}` }],
					isError: true,
				};
			}
		}) as any
	);

	tool(
		"android_save_screenshot",
		"Save Screenshot",
		"Take a screenshot and save it to a PNG file on this computer.",
		{
			device: deviceParam,
			saveTo: z.string().describe("Absolute path to save the screenshot to, ending with .png"),
		},
		{},
		async ({ device, saveTo }) => {
			validateFileExtension(saveTo, ALLOWED_SCREENSHOT_EXTENSIONS);
			validateOutputPath(saveTo);
			const id = adb.resolveDevice(device);
			const screenshot = adb.adb(id, "exec-out", "screencap", "-p");
			fs.writeFileSync(saveTo, screenshot);
			return `Screenshot saved to: ${saveTo}`;
		}
	);

	tool(
		"android_list_elements",
		"List Screen Elements",
		"List UI elements on the current screen with text, accessibility labels, resource ids, and pixel coordinates. Use this to find where to tap. Do not cache this result.",
		{ device: deviceParam },
		{ readOnlyHint: true },
		async ({ device }) => {
			const id = adb.resolveDevice(device);
			const elements = ui.getElements(id).map(el => ({
				type: el.type,
				text: el.text,
				label: el.label,
				identifier: el.identifier,
				focused: el.focused,
				clickable: el.clickable,
				coordinates: {
					x: el.rect.x + Math.floor(el.rect.width / 2),
					y: el.rect.y + Math.floor(el.rect.height / 2),
				},
				rect: el.rect,
			}));
			return JSON.stringify({ elements }, null, 2);
		}
	);

	tool(
		"android_wait_for_element",
		"Wait For Element",
		"Wait until a UI element appears on screen. Use this instead of a fixed sleep when content loads dynamically. Returns element info and center coordinates when found.",
		{
			device: deviceParam,
			...selectorParams,
			timeout: z.coerce.number().min(1).max(120).optional().describe("Max seconds to wait. Defaults to 10."),
		},
		{ readOnlyHint: true },
		async ({ device, timeout, ...selector }) => {
			const id = adb.resolveDevice(device);
			requireSelector(selector);
			const found = await ui.waitForElement(id, selector, (timeout ?? 10) * 1000);
			if (!found) {
				throw new ActionableError(
					`Element not found within ${timeout ?? 10}s for selector ${ui.describeSelector(selector)}. Check the screen with android_list_elements.`
				);
			}
			const center = elementCenter(found);
			return `Element found: ${JSON.stringify({ ...found, center })}`;
		}
	);

	// ------------------------------------------------------------------
	// Interaction
	// ------------------------------------------------------------------

	tool(
		"android_tap",
		"Tap Screen",
		"Tap the screen at x,y pixel coordinates. Use android_list_elements to find element coordinates.",
		{
			device: deviceParam,
			x: z.coerce.number().describe("X coordinate in pixels"),
			y: z.coerce.number().describe("Y coordinate in pixels"),
		},
		{},
		async ({ device, x, y }) => {
			const id = adb.resolveDevice(device);
			adb.shell(id, "input", "tap", `${x}`, `${y}`);
			return `Tapped at (${x}, ${y})`;
		}
	);

	tool(
		"android_tap_element",
		"Tap Element",
		"Find a UI element by selector and tap its center. More reliable than coordinate taps for dynamic layouts. Waits for the element to appear (default 5s).",
		{
			device: deviceParam,
			...selectorParams,
			index: z.coerce.number().min(0).optional().describe("Which match to tap when multiple elements match (0-based). Defaults to 0."),
			timeout: z.coerce.number().min(1).max(60).optional().describe("Max seconds to wait for the element. Defaults to 5."),
		},
		{},
		async ({ device, index, timeout, ...selector }) => {
			const id = adb.resolveDevice(device);
			requireSelector(selector);
			const wantedIndex = index ?? 0;
			const found = await ui.waitForElement(id, selector, (timeout ?? 5) * 1000, wantedIndex);
			if (!found) {
				throw new ActionableError(
					`Element not found within ${timeout ?? 5}s for selector ${ui.describeSelector(selector)} (index ${wantedIndex}). Check the screen with android_list_elements.`
				);
			}
			const center = elementCenter(found);
			adb.shell(id, "input", "tap", `${center.x}`, `${center.y}`);
			return `Tapped element ${ui.describeSelector(selector)} at (${center.x}, ${center.y})`;
		}
	);

	tool(
		"android_double_tap",
		"Double Tap",
		"Double-tap the screen at x,y pixel coordinates.",
		{
			device: deviceParam,
			x: z.coerce.number().describe("X coordinate in pixels"),
			y: z.coerce.number().describe("Y coordinate in pixels"),
		},
		{},
		async ({ device, x, y }) => {
			const id = adb.resolveDevice(device);
			adb.shell(id, "input", "tap", `${x}`, `${y}`);
			await new Promise(resolve => setTimeout(resolve, 100));
			adb.shell(id, "input", "tap", `${x}`, `${y}`);
			return `Double-tapped at (${x}, ${y})`;
		}
	);

	tool(
		"android_long_press",
		"Long Press",
		"Long-press the screen at x,y pixel coordinates.",
		{
			device: deviceParam,
			x: z.coerce.number().describe("X coordinate in pixels"),
			y: z.coerce.number().describe("Y coordinate in pixels"),
			duration: z.coerce.number().min(100).max(10000).optional().describe("Press duration in milliseconds. Defaults to 500."),
		},
		{},
		async ({ device, x, y, duration }) => {
			const id = adb.resolveDevice(device);
			const ms = duration ?? 500;
			adb.shell(id, "input", "swipe", `${x}`, `${y}`, `${x}`, `${y}`, `${ms}`);
			return `Long-pressed at (${x}, ${y}) for ${ms}ms`;
		}
	);

	tool(
		"android_swipe",
		"Swipe Screen",
		"Swipe in a direction. Starts from screen center by default, or from given x,y coordinates.",
		{
			device: deviceParam,
			direction: z.enum(["up", "down", "left", "right"]).describe("Swipe direction"),
			x: z.coerce.number().optional().describe("Start X coordinate. Defaults to screen center."),
			y: z.coerce.number().optional().describe("Start Y coordinate. Defaults to screen center."),
			distance: z.coerce.number().optional().describe("Swipe distance in pixels. Defaults to ~55% of screen for center swipes, 30% for coordinate swipes."),
			duration: z.coerce.number().min(50).max(5000).optional().describe("Swipe duration in milliseconds. Defaults to 500."),
		},
		{},
		async ({ device, direction, x, y, distance, duration }) => {
			const id = adb.resolveDevice(device);
			const size = adb.getScreenSize(id);
			const ms = duration ?? 500;

			let x0: number, y0: number, x1: number, y1: number;

			if (x !== undefined && y !== undefined) {
				const dY = distance ?? Math.floor(size.height * 0.3);
				const dX = distance ?? Math.floor(size.width * 0.3);
				x0 = x1 = x;
				y0 = y1 = y;
				switch (direction) {
					case "up": y1 = Math.max(0, y - dY); break;
					case "down": y1 = Math.min(size.height, y + dY); break;
					case "left": x1 = Math.max(0, x - dX); break;
					case "right": x1 = Math.min(size.width, x + dX); break;
				}
			} else {
				const centerX = size.width >> 1;
				const centerY = size.height >> 1;
				const dY = distance ? Math.floor(distance / 2) : Math.floor(size.height * 0.3);
				const dX = distance ? Math.floor(distance / 2) : Math.floor(size.width * 0.3);
				x0 = x1 = centerX;
				y0 = y1 = centerY;
				switch (direction) {
					case "up": y0 = centerY + dY; y1 = centerY - dY; break;
					case "down": y0 = centerY - dY; y1 = centerY + dY; break;
					case "left": x0 = centerX + dX; x1 = centerX - dX; break;
					case "right": x0 = centerX - dX; x1 = centerX + dX; break;
				}
			}

			adb.shell(id, "input", "swipe", `${x0}`, `${y0}`, `${x1}`, `${y1}`, `${ms}`);
			return `Swiped ${direction} from (${x0}, ${y0}) to (${x1}, ${y1})`;
		}
	);

	tool(
		"android_drag",
		"Drag And Drop",
		"Drag from one point and drop at another (uses a slow swipe that triggers drag behavior).",
		{
			device: deviceParam,
			fromX: z.coerce.number().describe("Start X coordinate"),
			fromY: z.coerce.number().describe("Start Y coordinate"),
			toX: z.coerce.number().describe("End X coordinate"),
			toY: z.coerce.number().describe("End Y coordinate"),
			duration: z.coerce.number().min(100).max(10000).optional().describe("Drag duration in milliseconds. Defaults to 1500."),
		},
		{},
		async ({ device, fromX, fromY, toX, toY, duration }) => {
			const id = adb.resolveDevice(device);
			const ms = duration ?? 1500;
			adb.shell(id, "input", "draganddrop", `${fromX}`, `${fromY}`, `${toX}`, `${toY}`, `${ms}`);
			return `Dragged from (${fromX}, ${fromY}) to (${toX}, ${toY})`;
		}
	);

	tool(
		"android_type_text",
		"Type Text",
		"Type text into the currently focused input field. Tap the field first. ASCII only (adb limitation).",
		{
			device: deviceParam,
			text: z.string().describe("The text to type (ASCII only)"),
			submit: z.boolean().optional().describe("Press ENTER after typing"),
			clear: z.boolean().optional().describe("Clear the field before typing (select-all + delete)"),
		},
		{},
		async ({ device, text, submit, clear }) => {
			const id = adb.resolveDevice(device);
			if (!adb.isAscii(text)) {
				throw new ActionableError(
					"Non-ASCII text is not supported by 'adb shell input text'. Type the ASCII part or use the device keyboard."
				);
			}

			if (clear) {
				clearField(id);
			}

			if (text !== "") {
				adb.shell(id, "input", "text", adb.escapeShellText(text));
			}
			if (submit) {
				adb.shell(id, "input", "keyevent", "KEYCODE_ENTER");
			}
			return `Typed text: ${text}${submit ? " (submitted)" : ""}`;
		}
	);

	tool(
		"android_press_key",
		"Press Key",
		"Press a hardware or navigation key. Common keys: BACK, HOME, ENTER, MENU, APP_SWITCH, POWER, VOLUME_UP, VOLUME_DOWN, DELETE, TAB, DPAD_UP/DOWN/LEFT/RIGHT/CENTER. Any Android KEYCODE_* name or numeric keycode also works.",
		{
			device: deviceParam,
			key: z.string().describe("Key name (e.g. 'BACK', 'KEYCODE_CAMERA') or numeric keycode"),
		},
		{},
		async ({ device, key }) => {
			const id = adb.resolveDevice(device);
			const upper = key.trim().toUpperCase();
			let keycode: string;
			if (/^\d+$/.test(upper)) {
				keycode = upper;
			} else if (!/^[A-Z0-9_]+$/.test(upper)) {
				throw new ActionableError(`Invalid key "${key}". Use a KEYCODE_* name or a numeric keycode.`);
			} else {
				keycode = KEYCODE_ALIASES[upper] ?? (upper.startsWith("KEYCODE_") ? upper : `KEYCODE_${upper}`);
			}
			adb.shell(id, "input", "keyevent", keycode);
			return `Pressed key: ${keycode}`;
		}
	);

	tool(
		"android_open_url",
		"Open URL",
		"Open a URL in the default browser on the device.",
		{
			device: deviceParam,
			url: z.string().describe("The http(s) URL to open"),
		},
		{},
		async ({ device, url }) => {
			const allowUnsafe = process.env.ANDROID_MCP_ALLOW_UNSAFE_URLS === "1";
			if (!allowUnsafe && !url.startsWith("http://") && !url.startsWith("https://")) {
				throw new ActionableError(
					"Only http:// and https:// URLs are allowed. Set ANDROID_MCP_ALLOW_UNSAFE_URLS=1 to allow other schemes (e.g. deep links)."
				);
			}
			const id = adb.resolveDevice(device);
			adb.shell(id, "am", "start", "-a", "android.intent.action.VIEW", "-d", adb.escapeShellText(url));
			return `Opened URL: ${url}`;
		}
	);

	tool(
		"android_open_notifications",
		"Open Notifications",
		"Expand the notification shade to inspect notifications. Use android_list_elements or android_take_screenshot afterwards to read them, and BACK key to close.",
		{ device: deviceParam },
		{},
		async ({ device }) => {
			const id = adb.resolveDevice(device);
			adb.shell(id, "cmd", "statusbar", "expand-notifications");
			return "Notification shade expanded";
		}
	);

	// ------------------------------------------------------------------
	// System
	// ------------------------------------------------------------------

	tool(
		"android_set_orientation",
		"Set Orientation",
		"Set the screen orientation (disables auto-rotate).",
		{
			device: deviceParam,
			orientation: z.enum(["portrait", "landscape"]).describe("Desired orientation"),
		},
		{},
		async ({ device, orientation }) => {
			const id = adb.resolveDevice(device);
			const value = orientation === "portrait" ? 0 : 1;
			adb.shell(id, "settings", "put", "system", "accelerometer_rotation", "0");
			adb.shell(id, "settings", "put", "system", "user_rotation", `${value}`);
			return `Orientation set to ${orientation}`;
		}
	);

	tool(
		"android_start_recording",
		"Start Screen Recording",
		"Start recording the device screen in the background. Stop it with android_stop_recording. Max duration is 180 seconds (Android limit).",
		{
			device: deviceParam,
			timeLimit: z.coerce.number().min(1).max(MAX_RECORDING_SECONDS).optional().describe("Auto-stop after this many seconds. Defaults to 180 (maximum)."),
			maxSize: z.number().int().min(16).max(4096).optional().describe("Maximum video dimension in pixels, e.g. 480."),
		},
		{},
		async ({ device, timeLimit, maxSize }) => {
			const id = adb.resolveDevice(device);
			if (activeRecordings.has(id)) {
				throw new ActionableError(
					`Device "${id}" is already being recorded. Stop it first with android_stop_recording.`
				);
			}

			const devicePath = `/sdcard/android-mcp-recording-${Date.now()}.mp4`;
			const args = ["shell", "screenrecord"];
			if (maxSize) {
				const size = adb.getScreenSize(id);
				const scale = Math.min(1, maxSize / Math.max(size.width, size.height));
				const width = Math.max(2, Math.floor(size.width * scale / 2) * 2);
				const height = Math.max(2, Math.floor(size.height * scale / 2) * 2);
				args.push("--size", `${width}x${height}`);
			}
			args.push("--time-limit", `${timeLimit ?? MAX_RECORDING_SECONDS}`);
			args.push(devicePath);

			const child = adb.spawnAdb(id, ...args);
			const recording: ActiveRecording = { process: child, devicePath, startedAt: Date.now() };
			activeRecordings.set(id, recording);

			child.on("error", () => activeRecordings.delete(id));

			return `Screen recording started on ${id}. Use android_stop_recording to stop and save it.`;
		}
	);

	tool(
		"android_stop_recording",
		"Stop Screen Recording",
		"Stop the active screen recording, pull the video from the device, and save it as an .mp4 file on this computer.",
		{
			device: deviceParam,
			saveTo: z.string().optional().describe("Absolute path to save the .mp4 to. Defaults to a temporary file."),
		},
		{},
		async ({ device, saveTo }) => {
			const id = adb.resolveDevice(device);
			const recording = activeRecordings.get(id);
			if (!recording) {
				throw new ActionableError(
					`No active recording for device "${id}". Start one with android_start_recording.`
				);
			}
			activeRecordings.delete(id);

			const outputPath = saveTo ?? path.join(os.tmpdir(), `android-recording-${Date.now()}.mp4`);
			if (saveTo) {
				validateFileExtension(saveTo, ALLOWED_RECORDING_EXTENSIONS);
				validateOutputPath(saveTo);
			}

			// ask screenrecord on the device to finalize the file gracefully
			try {
				adb.shell(id, "killall", "-2", "screenrecord");
			} catch {
				// already exited (e.g. time limit reached)
			}

			await new Promise<void>(resolve => {
				const timer = setTimeout(() => {
					recording.process.kill("SIGKILL");
					resolve();
				}, 10000);
				if (recording.process.exitCode !== null) {
					clearTimeout(timer);
					resolve();
					return;
				}
				recording.process.on("close", () => {
					clearTimeout(timer);
					resolve();
				});
			});

			// give the device a moment to flush the mp4 moov atom
			await new Promise(resolve => setTimeout(resolve, 1000));

			try {
				adb.adb(id, "pull", recording.devicePath, outputPath);
			} catch (error: any) {
				throw new ActionableError(
					`Failed to pull recording from device: ${error.message}. The file may still be at ${recording.devicePath} on the device.`
				);
			}
			try {
				adb.shell(id, "rm", recording.devicePath);
			} catch {
				// non-fatal
			}

			const durationSeconds = Math.round((Date.now() - recording.startedAt) / 1000);
			const sizeMB = (fs.statSync(outputPath).size / (1024 * 1024)).toFixed(2);
			return `Recording saved to ${outputPath} (${sizeMB} MB, ~${durationSeconds}s)`;
		}
	);

	tool(
		"android_logcat",
		"Read Logcat",
		"Read recent device logs. Useful for debugging apps (Flutter, React Native, native). The 'crash' buffer contains crash reports.",
		{
			device: deviceParam,
			lines: z.coerce.number().min(1).max(2000).optional().describe("Number of recent lines to fetch. Defaults to 200."),
			buffer: z.enum(["main", "system", "crash", "events", "all"]).optional().describe("Log buffer to read. Defaults to 'main'. Use 'crash' for crash reports."),
			filter: z.string().optional().describe("Only return lines containing this text (case-insensitive), e.g. a package name or 'flutter'"),
		},
		{ readOnlyHint: true },
		async ({ device, lines, buffer, filter }) => {
			const id = adb.resolveDevice(device);
			const count = lines ?? 200;
			const buf = buffer ?? "main";
			const args = ["logcat", "-d", "-t", `${count}`];
			if (buf === "all") {
				args.push("-b", "main", "-b", "system", "-b", "crash", "-b", "events");
			} else {
				args.push("-b", buf);
			}
			let output = adb.adb(id, ...args).toString();
			if (filter) {
				const needle = filter.toLowerCase();
				output = output
					.split("\n")
					.filter(line => line.toLowerCase().includes(needle))
					.join("\n");
			}
			if (output.trim() === "") {
				return `No log lines matched (buffer: ${buf}${filter ? `, filter: "${filter}"` : ""}).`;
			}
			return output;
		}
	);

	return server;
};
