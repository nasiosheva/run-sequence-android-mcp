import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { RecordingManager } from "../dist/recording.js";

class FakeProcess extends EventEmitter {
	exitCode = null;
	kill() {
		this.exitCode = 0;
		this.emit("close");
		return true;
	}
}

const createFakeAdb = () => {
	const spawned = [];
	return {
		spawned,
		getScreenSize: () => ({ width: 1080, height: 2400 }),
		spawnAdb: (_device, ...args) => {
			const process = new FakeProcess();
			spawned.push({ args, process });
			return process;
		},
		shell: (_device, command) => {
			if (command === "killall") spawned.at(-1)?.process.kill();
			return "";
		},
		adb: (_device, command, source, output) => {
			assert.equal(command, "pull");
			assert.match(source, /^\/sdcard\/android-mcp-recording-/);
			fs.mkdirSync(path.dirname(output), { recursive: true });
			fs.writeFileSync(output, "video");
			return Buffer.from("");
		},
	};
};

test("pause and resume preserve ordered video segments in the manifest", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "recording-test-"));
	const adb = createFakeAdb();
	const recordings = new RecordingManager(adb, {
		artifactDirectory: root,
		defaultMaxSize: 480,
		defaultBitRate: 1_500_000,
		defaultTimeLimitSeconds: 30,
		settleDelayMs: 0,
	});

	const started = recordings.start("emulator-5554");
	assert.equal(started.status, "recording");
	assert.deepEqual(adb.spawned[0].args.slice(0, 6), ["shell", "screenrecord", "--size", "216x480", "--bit-rate", "1500000"]);

	const paused = await recordings.pause("emulator-5554");
	assert.equal(paused.status, "paused");
	assert.equal(paused.segments.length, 1);
	assert.ok(paused.segments[0].outputPath.endsWith("segment-01.mp4"));

	recordings.resume("emulator-5554");
	const stopped = await recordings.stop("emulator-5554");
	assert.equal(stopped.status, "stopped");
	assert.equal(stopped.segments.length, 2);
	assert.ok(stopped.segments.every(segment => fs.existsSync(segment.outputPath)));
	const manifest = JSON.parse(fs.readFileSync(stopped.manifestPath, "utf8"));
	assert.equal(manifest.status, "stopped");
	assert.equal(manifest.segments.length, 2);
});

test("stop supports an explicit final output path", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "recording-test-"));
	const outputPath = path.join(root, "evidence.mp4");
	const recordings = new RecordingManager(createFakeAdb(), {
		artifactDirectory: root,
		defaultMaxSize: 480,
		defaultBitRate: 1_500_000,
		defaultTimeLimitSeconds: 30,
		settleDelayMs: 0,
	});

	recordings.start("emulator-5554");
	const stopped = await recordings.stop("emulator-5554", outputPath);
	assert.equal(stopped.segments[0].outputPath, outputPath);
	assert.ok(fs.existsSync(outputPath));
});

test("discard records a terminal manifest state instead of leaving a stale recording", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "recording-test-"));
	const recordings = new RecordingManager(createFakeAdb(), {
		artifactDirectory: root,
		defaultMaxSize: 480,
		defaultBitRate: 1_500_000,
		defaultTimeLimitSeconds: 30,
		settleDelayMs: 0,
	});

	const started = recordings.start("emulator-5554");
	await recordings.discard("emulator-5554");
	assert.equal(recordings.count, 0);
	const manifest = JSON.parse(fs.readFileSync(started.manifestPath, "utf8"));
	assert.equal(manifest.status, "discarded");
	assert.ok(manifest.endedAt);
});
