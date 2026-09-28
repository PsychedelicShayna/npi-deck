import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { acquireLock, releaseLock, signalWorkerGroup } from "./npi-deck.ts";
import { processStartTime } from "../apps/server/src/owned/launcher.ts";

function lockPath(): string {
	return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "npi-deck-lock-")), "launcher.lock");
}

describe.skipIf(process.platform !== "linux")("launcher lock", () => {
	test("a second launch is refused while the holder lives", async () => {
		const file = lockPath();
		const holder = Bun.spawn(["sleep", "30"], { stdout: "ignore" });
		try {
			const start = fs.readFileSync(`/proc/${holder.pid}/stat`, "utf8");
			const startTime = start.slice(start.lastIndexOf(")") + 2).split(" ")[19];
			fs.writeFileSync(file, JSON.stringify({ pid: holder.pid, startTime, unit: "npi-deck" }));

			expect(acquireLock(file, "npi-deck")).toMatchObject({ pid: holder.pid, unit: "npi-deck" });
		} finally {
			holder.kill("SIGKILL");
		}
	});

	test("a lock left by a dead launcher, or by a reused pid, is taken over", () => {
		const file = lockPath();
		fs.writeFileSync(file, JSON.stringify({ pid: 2 ** 22 + 1, unit: "npi-deck" }));
		expect(acquireLock(file, "npi-deck")).toBeUndefined();
		expect(JSON.parse(fs.readFileSync(file, "utf8")).pid).toBe(process.pid);
		releaseLock(file);

		// Our own pid, but a start time that is not ours: the pid was reused.
		fs.writeFileSync(file, JSON.stringify({ pid: process.pid, startTime: "1", unit: "npi-deck" }));
		expect(acquireLock(file, "npi-deck")).toBeUndefined();
		releaseLock(file);
		expect(fs.existsSync(file)).toBe(false);
	});
});

test.skipIf(process.platform !== "linux")("direct launcher spares a reused worker process group", async () => {
	const worker = Bun.spawn(["sleep", "30"], { detached: true, stdout: "ignore", stderr: "ignore" });
	try {
		const startTime = processStartTime(worker.pid);
		expect(startTime).toBeDefined();
		signalWorkerGroup(worker.pid, "stale-starttime", "SIGTERM");
		await Bun.sleep(50);
		expect(worker.exitCode).toBeNull();
		signalWorkerGroup(worker.pid, startTime, "SIGTERM");
		await worker.exited;
		expect(worker.signalCode).not.toBeNull();
	} finally {
		if (worker.exitCode === null && worker.signalCode === null) worker.kill("SIGKILL");
		await worker.exited;
	}
});
