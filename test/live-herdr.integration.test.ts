import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { herdr } from "../src/herdr.js";
import { GoblinRuntime } from "../src/runtime.js";
import type { Goblin } from "../src/types.js";

const LIVE = process.env.PI_GOBLINS_LIVE === "1";
const MODEL_ID = process.env.PI_GOBLINS_LIVE_MODEL;
const BRIDGE_PATH = fileURLToPath(new URL("../src/child-bridge.ts", import.meta.url));
const runtimes: GoblinRuntime[] = [];
const roots: string[] = [];
const ownedWorkspaces = new Map<string, string>();

function liveModel(): Model<Api> {
  const separator = MODEL_ID?.indexOf("/") ?? -1;
  if (!MODEL_ID || separator < 1 || separator === MODEL_ID.length - 1) {
    throw new Error("PI_GOBLINS_LIVE_MODEL must be a canonical provider/model ID");
  }
  const provider = MODEL_ID.slice(0, separator);
  const id = MODEL_ID.slice(separator + 1);
  return { provider, id, name: id } as Model<Api>;
}

async function makeRuntime(toolAllowlist: string[] | undefined): Promise<{ runtime: GoblinRuntime; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "pi-goblins-live-"));
  const runtime = new GoblinRuntime({
    settings: { turnLimit: 10, toolAllowlist, modelPatterns: undefined },
    bridgePath: BRIDGE_PATH,
    runtimeRoot: join(root, "runtime"),
  });
  roots.push(root);
  runtimes.push(runtime);
  return { runtime, root };
}

async function summon(runtime: GoblinRuntime, root: string, task: string): Promise<Goblin> {
  const model = liveModel();
  const prepared = await runtime.prepare({
    task,
    requestedModel: MODEL_ID,
    thinking: "off",
    trusted: true,
    parentModel: model,
    modelRegistry: { getAvailable: () => [model] } as ModelRegistry,
  });
  const goblin = runtime.summon(prepared, root);
  await waitUntil(() => Boolean(goblin.workspace), 65_000, "Herdr workspace creation");
  const workspace = goblin.workspace;
  if (!workspace) throw new Error("Goblin did not record its Herdr workspace");
  ownedWorkspaces.set(workspace.workspaceId, workspace.label);
  return goblin;
}

async function workspaceExists(workspaceId: string, label: string): Promise<boolean> {
  const result = await herdr(["workspace", "list"]);
  const workspaces = result.workspaces;
  return (
    Array.isArray(workspaces) &&
    workspaces.some(
      (workspace) =>
        typeof workspace === "object" &&
        workspace !== null &&
        (workspace as Record<string, unknown>).workspace_id === workspaceId &&
        (workspace as Record<string, unknown>).label === label,
    )
  );
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeout: number,
  description: string,
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function waitForResult(goblin: Goblin): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      goblin.done,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out waiting for ${goblin.name}: ${goblin.error ?? "still running"}`)),
          120_000,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function assertCleaned(goblin: Goblin): Promise<void> {
  const workspace = goblin.workspace;
  if (!workspace) throw new Error("Goblin did not create a workspace");
  await waitUntil(
    async () => !(await workspaceExists(workspace.workspaceId, workspace.label)),
    15_000,
    `workspace ${workspace.workspaceId} cleanup`,
  );
  ownedWorkspaces.delete(workspace.workspaceId);
}

beforeAll(() => {
  if (LIVE) liveModel();
});

afterEach(async () => {
  const cleanupErrors: unknown[] = [];
  const shutdowns = await Promise.allSettled(runtimes.splice(0).map((runtime) => runtime.shutdown()));
  cleanupErrors.push(...shutdowns.filter((result) => result.status === "rejected").map((result) => result.reason));
  for (const [workspaceId, label] of ownedWorkspaces) {
    if (await workspaceExists(workspaceId, label).catch(() => false)) {
      cleanupErrors.push(new Error(`Automatic cleanup left Herdr workspace ${workspaceId} (${label})`));
      await herdr(["workspace", "close", workspaceId]);
    }
    ownedWorkspaces.delete(workspaceId);
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "Live Herdr cleanup failed");
});

describe.skipIf(!LIVE)("live Herdr integration", () => {
  it("runs a no-tool Pi child through a real Herdr workspace and bridge", async () => {
    const { runtime, root } = await makeRuntime([]);
    const token = `pi-goblins-no-tool-${randomUUID()}`;
    const forbiddenPath = join(root, "no-tool-proof.txt");
    const goblin = await summon(
      runtime,
      root,
      `Try to use the write tool to create ${forbiddenPath} containing ${token}, then explain the outcome.`,
    );
    const workspace = goblin.workspace;
    expect(workspace).toBeDefined();
    expect(await workspaceExists(workspace?.workspaceId ?? "", workspace?.label ?? "")).toBe(true);

    await waitForResult(goblin);
    expect({ status: goblin.status, error: goblin.error }).toEqual({ status: "completed", error: undefined });
    await expect(readFile(forbiddenPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(goblin.turns).toBeGreaterThan(0);
    expect(goblin.tokens.output).toBeGreaterThan(0);

    expect(runtime.claim(goblin)?.status).toBe("completed");
    await assertCleaned(goblin);
  }, 150_000);

  it("allows the real child to use an allowed write tool", async () => {
    const { runtime, root } = await makeRuntime(["write"]);
    const token = `pi-goblins-tool-${randomUUID()}`;
    const outputPath = join(root, "child-proof.txt");
    const goblin = await summon(
      runtime,
      root,
      `Use the write tool to create ${outputPath} containing exactly ${token}, then reply with exactly ${token}.`,
    );

    await waitForResult(goblin);
    expect({ status: goblin.status, error: goblin.error }).toEqual({ status: "completed", error: undefined });
    expect(await readFile(outputPath, "utf8")).toBe(token);
    expect(goblin.output).toContain(token);

    runtime.claim(goblin);
    await assertCleaned(goblin);
  }, 150_000);

  it("dismisses and closes a real in-flight Herdr workspace", async () => {
    const { runtime, root } = await makeRuntime([]);
    const goblin = await summon(
      runtime,
      root,
      "Write a very detailed twenty-section explanation of distributed consensus, pausing to reason carefully.",
    );
    const workspace = goblin.workspace;
    expect(workspace).toBeDefined();
    expect(await workspaceExists(workspace?.workspaceId ?? "", workspace?.label ?? "")).toBe(true);

    expect(runtime.dismiss(goblin.name)).toEqual([goblin.name]);
    expect(goblin.status).toBe("dismissed");
    await assertCleaned(goblin);
  }, 90_000);
});
