import fs from "node:fs/promises";
import path from "node:path";
import { Miniflare } from "miniflare";
import { test } from "vitest";
import { recoverWorkflowStorage } from "../../../src/plugins/workflows/storage";
import { singleModuleManifest, useDispose, useTmp } from "../../test-shared";
import type { MiniflareOptions } from "miniflare";

const ID = "a".repeat(64);

async function writeFiles(root: string): Promise<string> {
	const directory = path.join(root, "miniflare-workflows-test");
	await fs.mkdir(directory, { recursive: true });
	for (const extension of [".sqlite", ".sqlite-shm", ".sqlite-wal"]) {
		await fs.writeFile(path.join(directory, ID + extension), "sqlite data");
	}
	return directory;
}

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
