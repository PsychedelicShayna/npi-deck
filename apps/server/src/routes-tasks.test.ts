/**
 * The kanban is one global board with a project filter: `GET /tasks` returns
 * every project's tasks unless `?cwd=` scopes it, and `projects[]` always
 * lists every project so the filter can offer them.
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ListTasksResponse, Task } from "@omp-deck/protocol";

import { closeDb, getDb, openDb } from "./db/index.ts";
import { buildTasksRouter } from "./routes-tasks.ts";

let dbDir: string | null = null;

afterEach(() => {
	closeDb();
	if (dbDir) {
		fs.rmSync(dbDir, { recursive: true, force: true });
		dbDir = null;
	}
});

function boot() {
	dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "npi-deck-tasks-route-"));
	openDb({ path: path.join(dbDir, "deck.db") });
	// Start from an empty board; migrations seed a welcome task.
	getDb().run("DELETE FROM tasks");
	const app = buildTasksRouter();
	const create = async (title: string, cwd?: string): Promise<Task> => {
		const res = await app.request("/tasks", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ title, ...(cwd === undefined ? {} : { cwd }) }),
		});
		expect(res.status).toBe(201);
		return (await res.json()) as Task;
	};
	const list = async (query = ""): Promise<ListTasksResponse> =>
		(await (await app.request(`/tasks${query}`)).json()) as ListTasksResponse;
	const patch = async (id: string, body: Record<string, unknown>): Promise<Task> =>
		(await (
			await app.request(`/tasks/${id}`, {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			})
		).json()) as Task;
	return { create, list, patch };
}

const titles = (r: ListTasksResponse) => r.tasks.map((t) => t.title).sort();

describe("GET /tasks project filter", () => {
	test("without a filter, every project's tasks are on the board, each carrying its cwd", async () => {
		const { create, list } = boot();
		await create("alpha-1", "/repos/alpha");
		await create("beta-1", "/repos/beta");
		const all = await list();
		expect(titles(all)).toEqual(["alpha-1", "beta-1"]);
		expect(Object.fromEntries(all.tasks.map((t) => [t.title, t.cwd]))).toEqual({
			"alpha-1": "/repos/alpha",
			"beta-1": "/repos/beta",
		});
	});

	test("?cwd= a project shows only that project, while projects[] still lists all of them", async () => {
		const { create, list } = boot();
		await create("alpha-1", "/repos/alpha");
		await create("alpha-2", "/repos/alpha");
		await create("beta-1", "/repos/beta");
		await create("loose");
		const alpha = await list(`?cwd=${encodeURIComponent("/repos/alpha")}`);
		expect(titles(alpha)).toEqual(["alpha-1", "alpha-2"]);
		expect(alpha.projects).toEqual([
			{ cwd: "/repos/alpha", label: "alpha", taskCount: 2 },
			{ cwd: "/repos/beta", label: "beta", taskCount: 1 },
			{ cwd: null, label: "Unassigned", taskCount: 1 },
		]);
		expect(titles(await list("?cwd=/repos/nowhere"))).toEqual([]);
	});

	test("blank cwds, new or legacy, are unassigned rather than a phantom project", async () => {
		const { create, list, patch } = boot();
		const blank = await create("blank", "   ");
		expect(blank.cwd).toBeUndefined();
		const filed = await create("filed", "/repos/alpha");
		const cleared = await patch(filed.id, { cwd: null });
		expect(cleared.cwd).toBeUndefined();
		await create("legacy", "/repos/beta");
		getDb().run("UPDATE tasks SET cwd = '' WHERE title = 'legacy'");

		const unassigned = await list("?cwd=");
		expect(titles(unassigned)).toEqual(["blank", "filed", "legacy"]);
		expect(unassigned.tasks.every((t) => t.cwd === undefined)).toBe(true);
		expect(unassigned.projects).toEqual([{ cwd: null, label: "Unassigned", taskCount: 3 }]);
	});
});
