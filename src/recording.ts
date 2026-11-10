import fs from "node:fs";
import path from "node:path";
import { ChildProcess } from "node:child_process";

import { ActionableError } from "./adb.js";

export interface RecordingOptions {
	timeLimit?: number;
	maxSize?: number;
	bitRate?: number;
}

export interface RecordingAdb {
	getScreenSize(deviceId: string): { width: number; height: number };
	spawnAdb(deviceId: string, ...args: string[]): ChildProcess;
	shell(deviceId: string, ...args: string[]): string;
	adb(deviceId: string, ...args: string[]): Buffer;
}

export interface RecordingSegment {
	index: number;
	devicePath: string;
	outputPath?: string;
	startedAt: string;
	endedAt?: string;
	durationSeconds?: number;
	sizeMB?: string;
}

export interface RecordingSession {
	id: string;
	device: string;
	status: "recording" | "paused" | "stopped" | "discarded" | "failed";
	startedAt: string;
	endedAt?: string;
	failureReason?: string;
	artifactDirectory: string;
	manifestPath: string;
	segments: RecordingSegment[];
	mergedPath?: string;
}

interface ActiveSegment extends RecordingSegment {
	process: ChildProcess;
	startedAtMs: number;
}

interface ActiveSession extends RecordingSession {
	activeSegment?: ActiveSegment;
}

export interface RecordingManagerOptions {
	artifactDirectory: string;
	defaultMaxSize: number;
	defaultBitRate: number;
	defaultTimeLimitSeconds: number;
	settleDelayMs?: number;
}

const publicSession = (session: ActiveSession): RecordingSession => {
	const { activeSegment, ...rest } = session;
	return {
		...rest,
		segments: session.segments.map(segment => {
			const { process, startedAtMs, ...publicSegment } = segment as ActiveSegment;
			return publicSegment;
		}),
	};
};

const writeManifest = (session: ActiveSession): void => {
	fs.mkdirSync(session.artifactDirectory, { recursive: true });
	fs.writeFileSync(session.manifestPath, JSON.stringify(publicSession(session), null, 2), "utf8");
};

export class RecordingManager {
	private readonly sessions = new Map<string, ActiveSession>();
	private readonly settleDelayMs: number;

	public constructor(private readonly adb: RecordingAdb, private readonly options: RecordingManagerOptions) {
		this.settleDelayMs = options.settleDelayMs ?? 1000;
	}

	public start(device: string, recordingOptions: RecordingOptions = {}, artifactDirectory = this.options.artifactDirectory): RecordingSession {
		if (this.sessions.has(device)) {
			throw new ActionableError(`Device "${device}" already has a recording session. Stop it first with android_stop_recording.`);
		}
		const id = `recording-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const sessionDirectory = path.join(artifactDirectory, id);
		const session: ActiveSession = {
			id,
			device,
			status: "recording",
			startedAt: new Date().toISOString(),
			artifactDirectory: sessionDirectory,
			manifestPath: path.join(sessionDirectory, "recording-manifest.json"),
			segments: [],
		};
		this.sessions.set(device, session);
		this.startSegment(session, recordingOptions);
		writeManifest(session);
		return this.publicSession(session);
	}

	public async pause(device: string): Promise<RecordingSession> {
		const session = this.requireSession(device);
		if (session.status !== "recording" || !session.activeSegment) {
			throw new ActionableError(`Recording session for device "${device}" is already paused.`);
		}
		try {
			await this.finishSegment(session);
		} catch (error: any) {
			this.failSession(session, error.message);
			throw error;
		}
		session.status = "paused";
		writeManifest(session);
		return this.publicSession(session);
	}

	public resume(device: string, recordingOptions: RecordingOptions = {}): RecordingSession {
		const session = this.requireSession(device);
		if (session.status !== "paused") {
			throw new ActionableError(`Recording session for device "${device}" is not paused.`);
		}
		session.status = "recording";
		this.startSegment(session, recordingOptions);
		writeManifest(session);
		return this.publicSession(session);
	}

	public async stop(device: string, saveTo?: string): Promise<RecordingSession> {
		const session = this.requireSession(device);
		try {
			if (session.activeSegment) await this.finishSegment(session, saveTo);
		} catch (error: any) {
			this.failSession(session, error.message);
			throw error;
		}
		session.status = "stopped";
		session.endedAt = new Date().toISOString();
		this.sessions.delete(device);
		writeManifest(session);
		return this.publicSession(session);
	}

	public async discard(device: string): Promise<void> {
		const session = this.sessions.get(device);
		if (!session) return;
		if (session.activeSegment) {
			try { this.adb.shell(device, "killall", "-2", "screenrecord"); } catch { /* already stopped */ }
			await this.waitForExit(session.activeSegment.process);
			try { this.adb.shell(device, "rm", session.activeSegment.devicePath); } catch { /* non-fatal */ }
		}
		this.sessions.delete(device);
		session.status = "discarded";
		session.endedAt = new Date().toISOString();
		writeManifest(session);
	}

	public has(device: string): boolean {
		return this.sessions.has(device);
	}

	public get count(): number {
		return this.sessions.size;
	}

	public stopAll(): void {
		for (const [device, session] of this.sessions) {
			try { this.adb.shell(device, "killall", "-2", "screenrecord"); } catch { /* already stopped */ }
			session.activeSegment?.process.kill("SIGKILL");
		}
		this.sessions.clear();
	}

	private startSegment(session: ActiveSession, recordingOptions: RecordingOptions): void {
		const size = this.adb.getScreenSize(session.device);
		const maxSize = recordingOptions.maxSize ?? this.options.defaultMaxSize;
		const scale = Math.min(1, maxSize / Math.max(size.width, size.height));
		const width = Math.max(2, Math.floor(size.width * scale / 2) * 2);
		const height = Math.max(2, Math.floor(size.height * scale / 2) * 2);
		const index = session.segments.length + 1;
		const devicePath = `/sdcard/android-mcp-recording-${Date.now()}-${index}.mp4`;
		const process = this.adb.spawnAdb(session.device, "shell", "screenrecord", "--size", `${width}x${height}`, "--bit-rate", `${recordingOptions.bitRate ?? this.options.defaultBitRate}`, "--time-limit", `${recordingOptions.timeLimit ?? this.options.defaultTimeLimitSeconds}`, devicePath);
		const segment: ActiveSegment = { index, devicePath, startedAt: new Date().toISOString(), process, startedAtMs: Date.now() };
		session.segments.push(segment);
		session.activeSegment = segment;
		process.once("error", () => {
			if (this.sessions.get(session.device) === session && session.activeSegment === segment) this.failSession(session, "screenrecord process failed to start.");
		});
	}

	private async finishSegment(session: ActiveSession, saveTo?: string): Promise<void> {
		const segment = session.activeSegment;
		if (!segment) return;
		session.activeSegment = undefined;
		try { this.adb.shell(session.device, "killall", "-2", "screenrecord"); } catch { /* already stopped */ }
		await this.waitForExit(segment.process);
		if (this.settleDelayMs > 0) await new Promise(resolve => setTimeout(resolve, this.settleDelayMs));
		const outputPath = saveTo ?? path.join(session.artifactDirectory, `segment-${String(segment.index).padStart(2, "0")}.mp4`);
		try {
			this.adb.adb(session.device, "pull", segment.devicePath, outputPath);
		} catch (error: any) {
			throw new ActionableError(`Failed to pull recording segment ${segment.index}: ${error.message}. The file may still be at ${segment.devicePath} on the device.`);
		}
		try { this.adb.shell(session.device, "rm", segment.devicePath); } catch { /* non-fatal */ }
		segment.outputPath = outputPath;
		segment.endedAt = new Date().toISOString();
		segment.durationSeconds = Math.round((Date.now() - segment.startedAtMs) / 1000);
		try { segment.sizeMB = (fs.statSync(outputPath).size / (1024 * 1024)).toFixed(2); } catch { /* pull adapters may not create a local file */ }
	}

	private async waitForExit(process: ChildProcess): Promise<void> {
		await new Promise<void>(resolve => {
			const timer = setTimeout(() => { process.kill("SIGKILL"); resolve(); }, 10000);
			if (process.exitCode !== null) { clearTimeout(timer); resolve(); return; }
			process.once("close", () => { clearTimeout(timer); resolve(); });
		});
	}

	private requireSession(device: string): ActiveSession {
		const session = this.sessions.get(device);
		if (!session) throw new ActionableError(`No active recording session for device "${device}". Start one with android_start_recording.`);
		return session;
	}

	private failSession(session: ActiveSession, failureReason: string): void {
		session.activeSegment = undefined;
		session.status = "failed";
		session.endedAt = new Date().toISOString();
		session.failureReason = failureReason;
		this.sessions.delete(session.device);
		writeManifest(session);
	}

	private publicSession(session: ActiveSession): RecordingSession {
		return publicSession(session);
	}
}
