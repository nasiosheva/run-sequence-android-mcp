import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { AdbClient, ActionableError, validatePackageName } from "./adb.js";
import { UiInspector, ElementSelector, elementCenter } from "./ui.js";
import { RecordingManager, RecordingOptions, RecordingSession } from "./recording.js";

const SERVER_VERSION = "1.0.0";
const ALLOWED_SCREENSHOT_EXTENSIONS = [".png"];
const ALLOWED_RECORDING_EXTENSIONS = [".mp4"];
const MAX_RECORDING_SECONDS = 180; // hard limit of android screenrecord
const DEFAULT_RECORDING_TIME_LIMIT_SECONDS = 30;
const DEFAULT_RECORDING_MAX_SIZE = 480;
const DEFAULT_RECORDING_BIT_RATE = 1_500_000;

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

type CaptureMode = "none" | "on_assertion_failure" | "before_after";

interface TestRun {
	id: string;
	name?: string;
	status: "active" | "passed" | "failed";
	startedAt: string;
	endedAt?: string;
	artifactDirectory: string;
	manifestPath: string;
	checkpoints: Array<{ name: string; capturedAt: string; artifacts: Record<string, string> }>;
	recordingSessions: string[];
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
	const transientDirectory = path.join(os.tmpdir(), "android-mcp-transient");
	fs.rmSync(transientDirectory, { recursive: true, force: true });
	fs.mkdirSync(transientDirectory, { recursive: true });
	const recordings = new RecordingManager(adb, {
		artifactDirectory: transientDirectory,
		defaultMaxSize: DEFAULT_RECORDING_MAX_SIZE,
		defaultBitRate: DEFAULT_RECORDING_BIT_RATE,
		defaultTimeLimitSeconds: DEFAULT_RECORDING_TIME_LIMIT_SECONDS,
	});
	const testRuns = new Map<string, TestRun>();
	const cleanRuntimeState = (): void => {
		recordings.stopAll();
		testRuns.clear();
		fs.rmSync(transientDirectory, { recursive: true, force: true });
		fs.mkdirSync(transientDirectory, { recursive: true });
	};
	process.once("exit", () => {
		recordings.stopAll();
		fs.rmSync(transientDirectory, { recursive: true, force: true });
	});

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
		textRegex: z.string().optional().describe("Match visible text with a JavaScript regular expression"),
		resourceId: z
			.string()
			.optional()
			.describe("Match by resource id. Short ids like 'btn_login' are auto-expanded using the foreground app package"),
		contentDesc: z.string().optional().describe("Match by accessibility label / content description (substring, case-insensitive)"),
		contentDescExact: z.string().optional().describe("Match an accessibility label / content description exactly"),
		className: z.string().optional().describe("Match by class name, e.g. 'android.widget.Button' or just 'Button'"),
		clickable: z.boolean().optional().describe("Match the element clickable state"),
		enabled: z.boolean().optional().describe("Match the element enabled state"),
		focused: z.boolean().optional().describe("Match the element focused state"),
		checked: z.boolean().optional().describe("Match the element checked state"),
		nearText: z.string().optional().describe("Match an element near visible text (case-insensitive)"),
		maxDistance: z.number().int().min(1).max(32767).optional().describe("Maximum distance in pixels for nearText; defaults to 200"),
	};

	const requireSelector = (selector: ElementSelector): void => {
		if (!ui.hasAnySelector(selector)) {
			throw new ActionableError(
				"At least one selector is required. Use text, textContains, textRegex, resourceId, contentDesc, contentDescExact, className, nearText, or an element state."
			);
		}
	};

	const coordinate = z.number().int().min(0).max(32767);
	const typeText = (id: string, text: string): void => {
		if (adb.isAscii(text)) {
			adb.shell(id, "input", "text", adb.escapeShellText(text));
			return;
		}
		try {
			adb.shell(id, "cmd", "clipboard", "set", adb.escapeShellText(text));
			adb.shell(id, "input", "keyevent", "KEYCODE_PASTE");
		} catch (error: any) {
			throw new ActionableError(
				`Unicode input requires the Android clipboard shell command. The device rejected it: ${error.message}`
			);
		}
	};
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
	const waitForForegroundApp = async (id: string, packageName: string, activity: string | undefined, timeoutMs: number): Promise<boolean> => {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const current = adb.getCurrentApp(id);
			if (current.packageName === packageName && (activity === undefined || current.activity === activity)) {
				return true;
			}
			if (Date.now() >= deadline) {
				return false;
			}
			await new Promise(resolve => setTimeout(resolve, 1000));
		}
	};
	const captureArtifacts = (id: string, directory: string, prefix: string): Record<string, string> => {
		fs.mkdirSync(directory, { recursive: true });
		const stamp = Date.now();
		const artifacts: Record<string, string> = {};
		try {
			const screenshotPath = path.join(directory, `${prefix}-${stamp}.png`);
			fs.writeFileSync(screenshotPath, adb.adb(id, "exec-out", "screencap", "-p"));
			artifacts.screenshot = screenshotPath;
		} catch { /* capture should not hide the original failure */ }
		try {
			const uiPath = path.join(directory, `${prefix}-${stamp}.xml`);
			fs.writeFileSync(uiPath, adb.adb(id, "exec-out", "uiautomator", "dump", "/dev/tty"));
			artifacts.uiHierarchy = uiPath;
		} catch {
			// Some secure screens do not expose an accessibility hierarchy.
		}
		try {
			const logPath = path.join(directory, `${prefix}-${stamp}.log`);
			fs.writeFileSync(logPath, adb.adb(id, "logcat", "-d", "-t", "200"));
			artifacts.logcat = logPath;
		} catch {
			// Log collection must not hide the original test failure.
		}
		return artifacts;
	};
	const writeTestRun = (run: TestRun): void => fs.writeFileSync(run.manifestPath, JSON.stringify(run, null, 2), "utf8");
	const createTestRun = (name?: string): TestRun => {
		const id = `test-run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const artifactDirectory = path.join(transientDirectory, "test-runs", id);
		fs.mkdirSync(artifactDirectory, { recursive: true });
		const run: TestRun = { id, name, status: "active", startedAt: new Date().toISOString(), artifactDirectory, manifestPath: path.join(artifactDirectory, "manifest.json"), checkpoints: [], recordingSessions: [] };
		testRuns.set(id, run);
		writeTestRun(run);
		return run;
	};
	const resolveTestRun = (testRunId?: string, testName?: string): TestRun | undefined => {
		if (!testRunId && !testName) return undefined;
		if (testRunId) {
			const run = testRuns.get(testRunId);
			if (!run) throw new ActionableError(`Test run "${testRunId}" was not found. Start one with android_start_test_run.`);
			return run;
		}
		return createTestRun(testName);
	};
	const saveCheckpoint = (id: string, name: string, run?: TestRun): Record<string, string> => {
		const artifacts = captureArtifacts(id, run?.artifactDirectory ?? transientDirectory, `checkpoint-${name.replace(/[^a-zA-Z0-9_-]/g, "-")}`);
		if (run) {
			run.checkpoints.push({ name, capturedAt: new Date().toISOString(), artifacts });
			writeTestRun(run);
		}
		return artifacts;
	};
	const startRecording = (id: string, options: RecordingOptions = {}, run?: TestRun): RecordingSession => {
		const recording = recordings.start(id, options, run?.artifactDirectory);
		if (run) { run.recordingSessions.push(recording.id); writeTestRun(run); }
		return recording;
	};
	const stopRecording = async (id: string, saveTo?: string): Promise<RecordingSession> => recordings.stop(id, saveTo);
	const mergeRecordingSegments = (recording: RecordingSession, mergeTo: string): string => {
		if (recording.segments.length < 2) throw new ActionableError("At least two recording segments are required to merge a recording session.");
		validateFileExtension(mergeTo, ALLOWED_RECORDING_EXTENSIONS);
		validateOutputPath(mergeTo);
		const sources = recording.segments.map(segment => segment.outputPath).filter((value): value is string => value !== undefined);
		if (sources.length !== recording.segments.length) throw new ActionableError("Cannot merge: one or more recording segments were not pulled successfully.");
		const concatPath = path.join(recording.artifactDirectory, "ffmpeg-concat.txt");
		fs.writeFileSync(concatPath, sources.map(source => `file '${source.replace(/'/g, "'\\\\''")}'`).join("\n"), "utf8");
		try {
			execFileSync("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", concatPath, "-c", "copy", mergeTo], { stdio: "pipe" });
		} catch (error: any) {
			if (error.code === "ENOENT") throw new ActionableError("ffmpeg is not installed or not on PATH. Use the segment paths in the recording manifest instead.");
			throw new ActionableError(`ffmpeg could not merge the recording segments: ${error.stderr?.toString().trim() || error.message}`);
		}
		recording.mergedPath = mergeTo;
		fs.writeFileSync(recording.manifestPath, JSON.stringify(recording, null, 2), "utf8");
		return mergeTo;
	};
	const interpolate = (value: string, variables: Record<string, string>): string =>
		value.replace(/\{\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}/g, (_, name: string) => {
			if (!(name in variables)) throw new ActionableError(`Sequence variable "${name}" is not defined.`);
			return variables[name];
		});
	const interpolateSelector = (selector: ElementSelector, variables: Record<string, string>): ElementSelector =>
		Object.fromEntries(Object.entries(selector).map(([key, value]) => [key, typeof value === "string" ? interpolate(value, variables) : value]));
	const step = z.discriminatedUnion("action", [
		z.object({ action: z.literal("tap"), x: coordinate, y: coordinate }),
		z.object({ action: z.literal("swipe"), fromX: coordinate, fromY: coordinate, toX: coordinate, toY: coordinate, durationMs: z.number().int().min(1).max(10000) }),
		z.object({ action: z.literal("key"), key: z.enum(["BACK", "HOME", "ENTER", "TAB"]) }),
		z.object({ action: z.literal("wait"), durationMs: z.number().int().min(0).max(30000) }),
		z.object({ action: z.literal("text"), text: z.string().max(1000), clear: z.boolean().optional(), submit: z.boolean().optional() }),
		z.object({ action: z.literal("wait_for_element"), ...selectorParams, timeoutMs: z.number().int().min(1).max(30000).optional() }),
		z.object({ action: z.literal("assert_element"), ...selectorParams, timeoutMs: z.number().int().min(0).max(30000).optional() }),
		z.object({ action: z.literal("assert_no_element"), ...selectorParams, timeoutMs: z.number().int().min(0).max(30000).optional() }),
		z.object({ action: z.literal("assert_app"), packageName: z.string().min(1), activity: z.string().min(1).optional(), timeoutMs: z.number().int().min(0).max(30000).optional() }),
	]);
	type StoredFlow = { name: string; steps: unknown[]; variables?: Record<string, string>; savedAt: string };
	const flowFilePath = process.env.ANDROID_MCP_FLOWS_PATH ?? path.join(os.homedir(), ".android-mcp", "flows.json");
	const readFlows = (): StoredFlow[] => {
		try {
			const parsed: unknown = JSON.parse(fs.readFileSync(flowFilePath, "utf8"));
			if (!Array.isArray(parsed)) throw new Error("expected an array");
			return parsed as StoredFlow[];
		} catch (error: any) {
			if (error.code === "ENOENT") return [];
			throw new ActionableError(`Unable to read saved flows: ${error.message}`);
		}
	};
	const writeFlows = (flows: StoredFlow[]): void => {
		const directory = path.dirname(flowFilePath);
		fs.mkdirSync(directory, { recursive: true });
		const temporaryPath = `${flowFilePath}.${process.pid}.tmp`;
		fs.writeFileSync(temporaryPath, JSON.stringify(flows, null, 2), "utf8");
		fs.renameSync(temporaryPath, flowFilePath);
	};
	const validateFlowName = (name: string): void => {
		if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) {
			throw new ActionableError("Flow name must be 1-64 characters of letters, numbers, underscores, or hyphens.");
		}
	};

	const runSequence = async (
		device: string | undefined,
		variables: Record<string, string> | undefined,
		steps: any[],
		record?: RecordingOptions & { mode: "always" | "on_failure"; testRunId?: string; testName?: string; capture?: CaptureMode }
	): Promise<string> => {
			const sequenceVariables = variables ?? {};
			for (const s of steps) {
				if ((s.action === "wait_for_element" || s.action === "assert_element" || s.action === "assert_no_element") && !ui.hasAnySelector(s)) throw new Error(`A selector is required for ${s.action}`);
				if (s.action === "assert_app") validatePackageName(interpolate(s.packageName, sequenceVariables));
			}
			const id = adb.resolveDevice(device);
			const testRun = resolveTestRun(record?.testRunId, record?.testName);
			const ownsTestRun = Boolean(record?.testName && !record?.testRunId);
			if (record) startRecording(id, record, testRun);
			if (record?.capture === "before_after") saveCheckpoint(id, "before", testRun);
			try {
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
							if (s.text) typeText(id, interpolate(s.text, sequenceVariables));
							if (s.submit) adb.shell(id, "input", "keyevent", "KEYCODE_ENTER");
						}
					} catch (error: any) { throw new Error(`Sequence failed at step ${i + 1}: ${error.message}`); }
					continue;
				}
				if (s.action === "wait_for_element") {
					flush();
					const { action, timeoutMs, ...selector } = s;
					const found = await ui.waitForElement(id, interpolateSelector(selector, sequenceVariables), timeoutMs ?? 10000);
					if (!found) throw new Error(`Sequence failed at step ${i + 1}: element not found`);
					continue;
				}
				if (s.action === "assert_element" || s.action === "assert_no_element") {
					flush();
					const { action, timeoutMs, ...selector } = s;
					const timeout = timeoutMs ?? 0;
					const resolvedSelector = interpolateSelector(selector, sequenceVariables);
					const passed = action === "assert_element"
						? Boolean(await ui.waitForElement(id, resolvedSelector, timeout))
						: await ui.waitForNoElement(id, resolvedSelector, timeout);
					if (!passed) throw new Error(`Sequence assertion failed at step ${i + 1}: ${action} ${ui.describeSelector(selector)}`);
					continue;
				}
				if (s.action === "assert_app") {
					flush();
					const packageName = interpolate(s.packageName, sequenceVariables);
					const activity = s.activity === undefined ? undefined : interpolate(s.activity, sequenceVariables);
					const passed = await waitForForegroundApp(id, packageName, activity, s.timeoutMs ?? 0);
					if (!passed) {
						const current = adb.getCurrentApp(id);
						throw new Error(`Sequence assertion failed at step ${i + 1}: expected foreground app ${packageName}${activity ? `/${activity}` : ""}, got ${current.packageName}/${current.activity}`);
					}
					continue;
				}
				if (!commands.length) batchStart = i;
				if (s.action === "tap") commands.push(`input tap ${s.x} ${s.y}`);
				else if (s.action === "swipe") commands.push(`input swipe ${s.fromX} ${s.fromY} ${s.toX} ${s.toY} ${s.durationMs}`);
				else if (s.action === "key") commands.push(`input keyevent KEYCODE_${s.key}`);
			}
			flush();
			const result: Record<string, unknown> = { device: id, completed: steps.length };
			if (record?.mode === "always") {
				result.recording = await stopRecording(id);
			} else if (record?.mode === "on_failure") {
				await recordings.discard(id);
			}
			if (record?.capture === "before_after") result.afterCheckpoint = saveCheckpoint(id, "after", testRun);
			if (testRun) {
				if (ownsTestRun) { testRun.status = "passed"; testRun.endedAt = new Date().toISOString(); writeTestRun(testRun); }
				result.testRun = { id: testRun.id, manifestPath: testRun.manifestPath };
			}
			return JSON.stringify(result);
			} catch (error: any) {
				const artifacts = captureArtifacts(id, testRun?.artifactDirectory ?? transientDirectory, "sequence-failure");
				if (record?.capture === "before_after" || (record?.capture === "on_assertion_failure" && error.message.includes("Sequence assertion failed"))) saveCheckpoint(id, "failure", testRun);
				if (record && recordings.has(id)) {
					try {
						const recording = await stopRecording(id);
						artifacts.recordingManifest = recording.manifestPath;
						if (recording.segments.at(-1)?.outputPath) artifacts.recording = recording.segments.at(-1)!.outputPath!;
					} catch (recordingError: any) {
						artifacts.recordingError = recordingError.message;
					}
				}
				if (testRun) {
					if (ownsTestRun) { testRun.status = "failed"; testRun.endedAt = new Date().toISOString(); writeTestRun(testRun); }
					artifacts.testRunManifest = testRun.manifestPath;
				}
				throw new Error(`${error.message} Failure artifacts: ${JSON.stringify(artifacts)}`);
			}
	};

	const recordingParams = {
		mode: z.enum(["always", "on_failure"]).describe("always keeps a video for every run; on_failure keeps it only when the sequence fails."),
		testRunId: z.string().optional().describe("Optional test run created by android_start_test_run. Artifacts are stored in its manifest directory."),
		testName: z.string().min(1).max(120).optional().describe("Creates an implicit test run when testRunId is omitted."),
		capture: z.enum(["none", "on_assertion_failure", "before_after"]).optional().describe("Capture checkpoints around the sequence or when it fails."),
		timeLimit: z.coerce.number().int().min(1).max(MAX_RECORDING_SECONDS).optional().describe(`Auto-stop after this many seconds. Defaults to ${DEFAULT_RECORDING_TIME_LIMIT_SECONDS}.`),
		maxSize: z.number().int().min(16).max(4096).optional().describe(`Maximum video dimension. Defaults to ${DEFAULT_RECORDING_MAX_SIZE}px.`),
		bitRate: z.number().int().min(100_000).max(100_000_000).optional().describe(`Video bitrate in bits per second. Defaults to ${DEFAULT_RECORDING_BIT_RATE}.`),
	};

	tool("run_sequence", "Run Android Sequence", "Run ordered Android actions, batching consecutive input commands in one ADB shell. Optionally capture lightweight 480p evidence; failed runs save video, screenshot, UI XML, and logcat.",
		{ device: deviceParam, variables: z.record(z.string()).optional().describe("Reusable string values referenced as {{name}} in text, selectors, and assert_app."), steps: z.array(step).min(1).max(100), record: z.object(recordingParams).optional() }, {},
		async ({ device, variables, steps, record }) => runSequence(device, variables, steps, record)
	);

	tool(
		"android_start_test_run",
		"Start Test Run",
		"Create an artifact directory and manifest for a named test run. Use its id with run_sequence, checkpoints, and recordings.",
		{ name: z.string().min(1).max(120).optional() },
		{},
		async ({ name }) => {
			const run = createTestRun(name);
			return JSON.stringify({ id: run.id, artifactDirectory: run.artifactDirectory, manifestPath: run.manifestPath }, null, 2);
		}
	);

	tool(
		"android_capture_checkpoint",
		"Capture Test Checkpoint",
		"Capture a screenshot, UI hierarchy, and logcat for a test checkpoint; stores it in the test-run manifest when provided.",
		{ device: deviceParam, name: z.string().min(1).max(120), testRunId: z.string().optional() },
		{ readOnlyHint: true },
		async ({ device, name, testRunId }) => {
			const id = adb.resolveDevice(device);
			const run = testRunId ? resolveTestRun(testRunId) : undefined;
			return JSON.stringify({ device: id, name, artifacts: saveCheckpoint(id, name, run), manifestPath: run?.manifestPath }, null, 2);
		}
	);

	tool(
		"android_finish_test_run",
		"Finish Test Run",
		"Finalize a test-run manifest after all scenarios have completed.",
		{ testRunId: z.string(), status: z.enum(["passed", "failed"]) },
		{},
		async ({ testRunId, status }) => {
			const run = resolveTestRun(testRunId)!;
			run.status = status;
			run.endedAt = new Date().toISOString();
			writeTestRun(run);
			return JSON.stringify({ id: run.id, status: run.status, manifestPath: run.manifestPath }, null, 2);
		}
	);

	tool(
		"android_save_flow",
		"Save Flow",
		"Persist a named Android sequence. Saving the same name replaces its previous definition.",
		{ name: z.string(), steps: z.array(step).min(1).max(100), variables: z.record(z.string()).optional().describe("Default values, which callers can override when running the flow.") },
		{},
		async ({ name, steps, variables }) => {
			validateFlowName(name);
			const flows = readFlows().filter(flow => flow.name !== name);
			flows.push({ name, steps, variables, savedAt: new Date().toISOString() });
			writeFlows(flows);
			return `Saved flow "${name}" with ${steps.length} steps.`;
		}
	);

	tool(
		"android_list_flows",
		"List Saved Flows",
		"List persistent named sequences available to run.",
		{},
		{ readOnlyHint: true },
		async () => JSON.stringify({ flows: readFlows().map(({ name, savedAt, steps, variables }) => ({ name, savedAt, steps: steps.length, variables: Object.keys(variables ?? {}) })) }, null, 2)
	);

	tool(
		"android_run_flow",
		"Run Saved Flow",
		"Run a previously saved named sequence, optionally overriding its default variables.",
		{ device: deviceParam, name: z.string(), variables: z.record(z.string()).optional(), record: z.object(recordingParams).optional() },
		{},
		async ({ device, name, variables, record }) => {
			validateFlowName(name);
			const flow = readFlows().find(candidate => candidate.name === name);
			if (!flow) throw new ActionableError(`Saved flow "${name}" was not found. Use android_list_flows to see available flows.`);
			const parsedSteps = z.array(step).min(1).max(100).safeParse(flow.steps);
			if (!parsedSteps.success) throw new ActionableError(`Saved flow "${name}" is invalid: ${parsedSteps.error.message}`);
			return runSequence(device, { ...flow.variables, ...variables }, parsedSteps.data, record);
		}
	);

	tool(
		"android_delete_flow",
		"Delete Saved Flow",
		"Delete a named saved flow. Set confirm to true to execute.",
		{ name: z.string(), confirm: z.literal(true).optional() },
		{ destructiveHint: true },
		async ({ name, confirm }) => {
			validateFlowName(name);
			if (!confirm) return `Dry run: set confirm: true to delete saved flow "${name}".`;
			const flows = readFlows();
			if (!flows.some(flow => flow.name === name)) throw new ActionableError(`Saved flow "${name}" was not found.`);
			writeFlows(flows.filter(flow => flow.name !== name));
			return `Deleted saved flow "${name}".`;
		}
	);

	tool(
		"android_clear_saved_data",
		"Clear Saved MCP Data",
		"Permanently delete every saved flow and its default variables from this MCP's flow store. Set confirm to true to execute.",
		{ confirm: z.literal(true).optional() },
		{ destructiveHint: true },
		async ({ confirm }) => {
			const flowCount = readFlows().length;
			const recordingCount = recordings.count;
			if (!confirm) return `Dry run: set confirm: true to permanently delete ${flowCount} saved flow(s), stop ${recordingCount} active recording(s), and clear temporary MCP artifacts.`;
			try {
				fs.rmSync(flowFilePath, { force: true });
				cleanRuntimeState();
			} catch (error: any) {
				throw new ActionableError(`Unable to clear saved data: ${error.message}`);
			}
			return `Cleared ${flowCount} saved flow(s), stopped ${recordingCount} active recording(s), and removed temporary MCP artifacts.`;
		}
	);

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
		"android_install_split_apps",
		"Install Split APKs",
		"Install a base APK and its split APK files with adb install-multiple.",
		{
			device: deviceParam,
			apkPaths: z.array(z.string()).min(2).describe("Absolute paths to the base APK and every split APK"),
			grantPermissions: z.boolean().optional(),
		},
		{},
		async ({ device, apkPaths, grantPermissions }) => {
			const missing = apkPaths.find((apkPath: string) => !fs.existsSync(apkPath));
			if (missing) throw new ActionableError(`APK file not found at "${missing}"`);
			if (apkPaths.some((apkPath: string) => path.extname(apkPath).toLowerCase() !== ".apk")) {
				throw new ActionableError("android_install_split_apps accepts extracted .apk files. Extract .apks or .xapk archives first.");
			}
			const id = adb.resolveDevice(device);
			const args = ["install-multiple", "-r"];
			if (grantPermissions) args.push("-g");
			adb.adb(id, ...args, ...apkPaths);
			return `Installed ${apkPaths.length} split APK files`;
		}
	);

	tool(
		"android_clear_app_data",
		"Clear App Data",
		"Reset an app to its initial state by deleting its local data. Set confirm to true to execute; otherwise this is a dry run.",
		{ device: deviceParam, packageName: z.string(), confirm: z.literal(true).optional() },
		{ destructiveHint: true },
		async ({ device, packageName, confirm }) => {
			validatePackageName(packageName);
			if (!confirm) return `Dry run: set confirm: true to clear data for ${packageName}.`;
			const id = adb.resolveDevice(device);
			adb.shell(id, "pm", "clear", packageName);
			return `Cleared app data for ${packageName}`;
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
				enabled: el.enabled,
				checked: el.checked,
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
		"android_capture_state",
		"Capture Device State",
		"Capture a diagnostic snapshot: screenshot, accessible UI elements, foreground app, and recent logcat.",
		{ device: deviceParam, saveTo: z.string().optional().describe("Existing absolute directory for the screenshot") },
		{ readOnlyHint: true },
		async ({ device, saveTo }) => {
			const id = adb.resolveDevice(device);
			if (saveTo && (!path.isAbsolute(saveTo) || !fs.existsSync(saveTo) || !fs.statSync(saveTo).isDirectory())) {
				throw new ActionableError("saveTo must be an existing absolute directory.");
			}
			const screenshotPath = path.join(saveTo ?? transientDirectory, `android-state-${Date.now()}.png`);
			fs.writeFileSync(screenshotPath, adb.adb(id, "exec-out", "screencap", "-p"));
			return JSON.stringify({ device: id, screenshotPath, foregroundApp: adb.getCurrentApp(id), elements: ui.getElements(id), logcat: adb.adb(id, "logcat", "-d", "-t", "100").toString() }, null, 2);
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
			retries: z.coerce.number().int().min(0).max(3).optional().describe("Extra attempts if the tap command fails. Defaults to 0."),
			retryDelayMs: z.coerce.number().int().min(0).max(5000).optional().describe("Delay between retry attempts. Defaults to 250 ms."),
		},
		{},
		async ({ device, index, timeout, retries, retryDelayMs, ...selector }) => {
			const id = adb.resolveDevice(device);
			requireSelector(selector);
			const wantedIndex = index ?? 0;
			const found = await ui.waitForElement(id, selector, (timeout ?? 5) * 1000, wantedIndex);
			if (!found) {
				throw new ActionableError(
					`Element not found within ${timeout ?? 5}s for selector ${ui.describeSelector(selector)} (index ${wantedIndex}). Check the screen with android_list_elements.`
				);
			}
			const attempts = (retries ?? 0) + 1;
			for (let attempt = 1; attempt <= attempts; attempt++) {
				try {
					const current = attempt === 1 ? found : await ui.waitForElement(id, selector, (timeout ?? 5) * 1000, wantedIndex);
					if (!current) throw new ActionableError("Element disappeared before it could be tapped.");
					const center = elementCenter(current);
					adb.shell(id, "input", "tap", `${center.x}`, `${center.y}`);
					return `Tapped element ${ui.describeSelector(selector)} at (${center.x}, ${center.y}) on attempt ${attempt}`;
				} catch (error) {
					if (attempt === attempts) throw error;
					await new Promise(resolve => setTimeout(resolve, retryDelayMs ?? 250));
				}
			}
			throw new ActionableError("Tap failed.");
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
		"Type text into the currently focused input field. Tap the field first. Non-ASCII text is pasted through the Android clipboard when supported by the device.",
		{
			device: deviceParam,
			text: z.string().describe("The text to type"),
			submit: z.boolean().optional().describe("Press ENTER after typing"),
			clear: z.boolean().optional().describe("Clear the field before typing (select-all + delete)"),
		},
		{},
		async ({ device, text, submit, clear }) => {
			const id = adb.resolveDevice(device);
			if (clear) {
				clearField(id);
			}

			if (text !== "") {
				typeText(id, text);
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
		"Start a lightweight 480p recording session in the background. Pause finalizes the current MP4 segment; resume starts another segment in the same manifest.",
		{
			device: deviceParam,
			testRunId: z.string().optional().describe("Optional test run that owns this recording session and its artifacts."),
			timeLimit: recordingParams.timeLimit,
			maxSize: recordingParams.maxSize,
			bitRate: recordingParams.bitRate,
		},
		{},
		async ({ device, testRunId, timeLimit, maxSize, bitRate }) => {
			const id = adb.resolveDevice(device);
			const recording = startRecording(id, { timeLimit, maxSize, bitRate }, testRunId ? resolveTestRun(testRunId) : undefined);
			return JSON.stringify({ message: `Screen recording started on ${id}.`, sessionId: recording.id, manifestPath: recording.manifestPath }, null, 2);
		}
	);

	tool(
		"android_pause_recording",
		"Pause Screen Recording",
		"Finalize and pull the current MP4 segment while preserving the recording session. Android screenrecord has no native pause support.",
		{ device: deviceParam },
		{},
		async ({ device }) => {
			const id = adb.resolveDevice(device);
			const recording = await recordings.pause(id);
			return JSON.stringify({ sessionId: recording.id, status: recording.status, segment: recording.segments.at(-1), manifestPath: recording.manifestPath }, null, 2);
		}
	);

	tool(
		"android_resume_recording",
		"Resume Screen Recording",
		"Start the next MP4 segment in a paused recording session. Segments are listed in the session manifest.",
		{ device: deviceParam, timeLimit: recordingParams.timeLimit, maxSize: recordingParams.maxSize, bitRate: recordingParams.bitRate },
		{},
		async ({ device, timeLimit, maxSize, bitRate }) => {
			const id = adb.resolveDevice(device);
			const recording = recordings.resume(id, { timeLimit, maxSize, bitRate });
			return JSON.stringify({ sessionId: recording.id, status: recording.status, nextSegment: recording.segments.at(-1), manifestPath: recording.manifestPath }, null, 2);
		}
	);

	tool(
		"android_stop_recording",
		"Stop Screen Recording",
		"Stop the recording session and pull its final MP4 segment. Paused/resumed sessions retain every segment in the manifest; use mergeTo to combine them with ffmpeg when available.",
		{
			device: deviceParam,
			saveTo: z.string().optional().describe("Absolute path to save the .mp4 to. Defaults to a temporary file."),
			mergeTo: z.string().optional().describe("Optional absolute .mp4 output for merging two or more paused/resumed segments with ffmpeg, when available."),
		},
		{},
		async ({ device, saveTo, mergeTo }) => {
			const id = adb.resolveDevice(device);
			if (saveTo) {
				validateFileExtension(saveTo, ALLOWED_RECORDING_EXTENSIONS);
				validateOutputPath(saveTo);
			}
			const recording = await stopRecording(id, saveTo);
			const mergedPath = mergeTo ? mergeRecordingSegments(recording, mergeTo) : undefined;
			return JSON.stringify({ sessionId: recording.id, segments: recording.segments, manifestPath: recording.manifestPath, mergedPath }, null, 2);
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
