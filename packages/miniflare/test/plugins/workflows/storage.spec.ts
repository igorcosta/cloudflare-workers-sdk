import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { transform } from "esbuild";
import { Miniflare } from "miniflare";
import { test } from "vitest";
import { recoverWorkflowStorage } from "../../../src/plugins/workflows/storage";
import { singleModuleManifest, useDispose, useTmp } from "../../test-shared";
import type { MiniflareOptions } from "miniflare";

const ID = "a".repeat(64);
const STORAGE_PATH = `/core/workflow-storage/test/${ID}`;

async function startStorage(
	root: string,
	diskScript?: string
): Promise<Miniflare> {
	const source = await fs.readFile(
		path.join(__dirname, "../../../src/workers/workflows/storage.worker.ts"),
		"utf8"
	);
	const { code } = await transform(source, { loader: "ts", format: "esm" });
	const workers: NonNullable<MiniflareOptions["workers"]> = [
		{
			config: {
				name: "storage-test",
				compatibilityDate: "2024-10-22",
				manifest: singleModuleManifest(code),
				env: {
					DISK:
						diskScript !== undefined
							? { type: "worker", worker: "disk-test" }
							: { type: "disk", path: root, writable: true },
				},
			},
		},
	];
	if (diskScript !== undefined) {
		workers.push({
			config: {
				name: "disk-test",
				compatibilityDate: "2024-10-22",
				manifest: singleModuleManifest(diskScript),
				env: { DISK: { type: "disk", path: root, writable: true } },
			},
		});
	}
	const miniflare = new Miniflare({ workers });
	useDispose(miniflare);
	return miniflare;
}

async function writeFiles(root: string): Promise<string> {
	const directory = path.join(root, "miniflare-workflows-test");
	await fs.mkdir(directory, { recursive: true });
	for (const extension of [".sqlite", ".sqlite-shm", ".sqlite-wal"]) {
		await fs.writeFile(path.join(directory, ID + extension), "sqlite data");
	}
	return directory;
}

test("disk-backed deletion defers cleanup and serializes overlapping requests", async ({
	expect,
}) => {
	const root = await useTmp();
	const directory = await writeFiles(root);
	const storage = await startStorage(root);
	const deferred = await storage.dispatchFetch(
		`http://localhost${STORAGE_PATH}?defer=1`,
		{ method: "DELETE" }
	);
	await deferred.text();
	expect(deferred.status).toBe(202);
	expect(
		await fs.readFile(path.join(directory, ID + ".sqlite-delete"), "utf8")
	).toBe("");
	const [deleted, waited] = await Promise.all([
		storage.dispatchFetch(`http://localhost${STORAGE_PATH}`, {
			method: "DELETE",
		}),
		storage.dispatchFetch(
			`http://localhost${STORAGE_PATH}?waitForPendingDelete=1`
		),
	]);
	expect(deleted.status).toBe(204);
	expect(waited.status).toBe(204);
	expect(await fs.readdir(directory)).toEqual([]);
});

test("disk-backed deletion refuses directories while still removing other SQLite files", async ({
	expect,
}) => {
	const root = await useTmp();
	const directory = await writeFiles(root);
	await fs.unlink(path.join(directory, ID + ".sqlite-shm"));
	await fs.mkdir(path.join(directory, ID + ".sqlite-shm"));
	await fs.writeFile(path.join(directory, ID + ".sqlite-shm", "keep"), "keep");
	const storage = await startStorage(root);
	const response = await storage.dispatchFetch(
		`http://localhost${STORAGE_PATH}`,
		{ method: "DELETE" }
	);
	await response.text();
	expect(response.status).toBe(500);
	expect((await fs.readdir(directory)).sort()).toEqual(
		[ID + ".sqlite-delete", ID + ".sqlite-shm"].sort()
	);
	expect(
		await fs.readFile(path.join(directory, ID + ".sqlite-shm", "keep"), "utf8")
	).toBe("keep");
});

test("recreation waits for a deletion whose marker is still being written", async ({
	expect,
}) => {
	const root = await useTmp();
	const directory = await writeFiles(root);
	const storage = await startStorage(
		root,
		`
let markerStarted = false;
export default {
	async fetch(request, env) {
		if (new URL(request.url).pathname === "/marker-started") {
			return Response.json(markerStarted);
		}
		if (request.method === "PUT") {
			markerStarted = true;
			await scheduler.wait(100);
		}
		return env.DISK.fetch(request);
	}
};
`
	);
	const disk = await storage.getWorker("disk-test");
	const deletion = storage
		.dispatchFetch(`http://localhost${STORAGE_PATH}?defer=1`, {
			method: "DELETE",
		})
		.then(async (response) => {
			await response.text();
			return response.status;
		});
	let markerStarted = false;
	for (let attempt = 0; attempt < 50 && !markerStarted; attempt++) {
		const response = await disk.fetch("http://localhost/marker-started");
		markerStarted = (await response.json()) === true;
		if (!markerStarted) {
			await wait(5);
		}
	}
	expect(markerStarted).toBe(true);
	const barrier = await storage.dispatchFetch(
		`http://localhost${STORAGE_PATH}?waitForPendingDelete=1`
	);
	expect(barrier.status).toBe(204);
	expect(await fs.readdir(directory)).toEqual([]);
	expect(await deletion).toBe(202);
});

test("disk-backed deletion retries transient disk errors for SQLite files", async ({
	expect,
}) => {
	const root = await useTmp();
	const directory = await writeFiles(root);
	const storage = await startStorage(
		root,
		`
const failures = new Set();
export default {
	async fetch(request, env) {
		const pathname = new URL(request.url).pathname;
		if (request.method === "DELETE" && /\\.sqlite(?:-shm|-wal)?$/.test(pathname) && !failures.has(pathname)) {
			failures.add(pathname);
			return new Response("File is locked", { status: 500 });
		}
		return env.DISK.fetch(request);
	}
};
`
	);
	const response = await storage.dispatchFetch(
		`http://localhost${STORAGE_PATH}`,
		{ method: "DELETE" }
	);
	expect(response.status).toBe(204);
	expect(await fs.readdir(directory)).toEqual([]);
});

test("deleting a missing instance preserves not-found and deferred responses", async ({
	expect,
}) => {
	const root = await useTmp();
	const storage = await startStorage(root);
	const missing = await storage.dispatchFetch(
		`http://localhost${STORAGE_PATH}`,
		{ method: "DELETE" }
	);
	await missing.text();
	expect(missing.status).toBe(404);
	const deferred = await storage.dispatchFetch(
		`http://localhost${STORAGE_PATH}?defer=1`,
		{ method: "DELETE" }
	);
	await deferred.text();
	expect(deferred.status).toBe(202);
	const barrier = await storage.dispatchFetch(
		`http://localhost${STORAGE_PATH}?waitForPendingDelete=1`
	);
	expect(barrier.status).toBe(204);
	expect(await fs.readdir(path.join(root, "miniflare-workflows-test"))).toEqual(
		[]
	);
});

test("bulk deletion removes orphaned SQLite sidecars and metadata but preserves directories", async ({
	expect,
}) => {
	const root = await useTmp();
	const directory = await writeFiles(root);
	await fs.unlink(path.join(directory, ID + ".sqlite"));
	await fs.writeFile(path.join(directory, "metadata.sqlite"), "metadata");
	await fs.writeFile(path.join(directory, "keep.txt"), "keep");
	await fs.mkdir(path.join(directory, "keep.sqlite"));
	await fs.writeFile(path.join(directory, "keep.sqlite", "keep"), "keep");
	const storage = await startStorage(root);
	const response = await storage.dispatchFetch(
		"http://localhost/core/workflow-storage/test",
		{ method: "DELETE" }
	);
	await response.text();
	expect(response.status).toBe(200);
	expect((await fs.readdir(directory)).sort()).toEqual([
		"keep.sqlite",
		"keep.txt",
	]);
	expect(
		await fs.readFile(path.join(directory, "keep.sqlite", "keep"), "utf8")
	).toBe("keep");
});

test("disk-backed storage restricts routes, methods and encoded paths", async ({
	expect,
}) => {
	const root = await useTmp();
	const directory = await writeFiles(root);
	const storage = await startStorage(root);
	for (const pathname of [
		"/core/do-storage/test",
		"/core/workflow-storage/test/invalid",
		`/core/workflow-storage/test%2F..%2Foutside/${ID}`,
		`/core/workflow-storage/test/${ID}%2F..`,
		`/core/workflow-storage/%invalid/${ID}`,
	]) {
		const response = await storage.dispatchFetch(
			`http://localhost${pathname}`,
			{ method: "DELETE" }
		);
		await response.text();
		expect([400, 404]).toContain(response.status);
	}
	const unsupported = await storage.dispatchFetch(
		`http://localhost${STORAGE_PATH}`,
		{ method: "PUT" }
	);
	await unsupported.text();
	expect(unsupported.status).toBe(405);
	expect(await fs.readdir(directory)).toHaveLength(3);
});

test("a restarted storage service finishes a persisted deletion before reuse", async ({
	expect,
}) => {
	const root = await useTmp();
	const directory = await writeFiles(root);
	await fs.writeFile(path.join(directory, ID + ".sqlite-delete"), "");
	const storage = await startStorage(root);
	const response = await storage.dispatchFetch(
		`http://localhost${STORAGE_PATH}?waitForPendingDelete=1`
	);
	expect(response.status).toBe(204);
	expect(await fs.readdir(directory)).toEqual([]);
});

test.for(["reload", "dispose"])(
	"%s finishes marked deletions without touching a replacement persistence root",
	async (action, { expect }) => {
		const root = await useTmp();
		const replacement = await useTmp();
		function options(persistPath: string): MiniflareOptions {
			return {
				resourcePersistencePath: persistPath,
				workers: [
					{
						config: {
							name: "worker",
							compatibilityDate: "2024-11-20",
							manifest: singleModuleManifest(`
import { WorkflowEntrypoint } from "cloudflare:workers";
export class TestWorkflow extends WorkflowEntrypoint { async run() {} }
export default { fetch() { return new Response("ok"); } };
`),
							env: {
								WORKFLOW: {
									type: "workflow",
									name: "test",
									worker: "worker",
									exportName: "TestWorkflow",
								},
							},
						},
					},
				],
			};
		}
		const miniflare = new Miniflare(options(root));
		useDispose(miniflare);
		await miniflare.ready;
		const directory = await writeFiles(path.join(root, "workflows"));
		const replacementDirectory = await writeFiles(
			path.join(replacement, "workflows")
		);
		await fs.writeFile(path.join(directory, ID + ".sqlite-delete"), "");
		if (action === "reload") {
			await miniflare.setOptions(options(replacement));
		} else {
			await miniflare.dispose();
		}
		expect(
			(await fs.readdir(directory)).filter((name) => name.startsWith(ID))
		).toEqual([]);
		expect(
			(await fs.readdir(replacementDirectory)).filter((name) =>
				name.startsWith(ID)
			)
		).toHaveLength(3);
		for (const extension of [".sqlite", ".sqlite-shm", ".sqlite-wal"]) {
			expect(
				await fs.readFile(
					path.join(replacementDirectory, ID + extension),
					"utf8"
				)
			).toBe("sqlite data");
		}
	}
);

test("shutdown recovery retains failed markers and does not recursively remove directories", async ({
	expect,
}) => {
	const root = await useTmp();
	const directory = await writeFiles(root);
	await fs.unlink(path.join(directory, ID + ".sqlite-shm"));
	await fs.mkdir(path.join(directory, ID + ".sqlite-shm"));
	await fs.writeFile(path.join(directory, ID + ".sqlite-delete"), "");
	await fs.writeFile(path.join(directory, "unmarked.sqlite"), "keep");
	const errors: Error[] = [];
	await recoverWorkflowStorage(root, (error) => errors.push(error));
	expect(errors).toHaveLength(1);
	expect((await fs.readdir(directory)).sort()).toEqual(
		[ID + ".sqlite-delete", ID + ".sqlite-shm", "unmarked.sqlite"].sort()
	);
});
