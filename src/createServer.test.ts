import { test, expect, beforeEach, afterEach } from "vitest";
import { createServer } from "./createServer.js";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

let testVaultPath: string;

beforeEach(async () => {
  testVaultPath = await mkdtemp(join(tmpdir(), "mcpvault-test-"));
});

afterEach(async () => {
  try {
    await rm(testVaultPath, { recursive: true });
  } catch {
    // Ignore cleanup errors
  }
});

test("createServer returns a Server instance", () => {
  const server = createServer(testVaultPath, { version: "1.0.0" });
  expect(server).toBeDefined();
  expect(typeof server.connect).toBe("function");
});

test("server registers 16 tools", async () => {
  const server = createServer(testVaultPath, { version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  const client = new Client({ name: "test-client", version: "1.0.0" });

  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);

  const result = await client.listTools();
  expect(result.tools).toHaveLength(20);

  const toolNames = result.tools.map((t) => t.name).sort();
  expect(toolNames).toEqual([
    "delete_note",
    "find_broken_links",
    "get_frontmatter",
    "get_notes_info",
    "get_vault_stats",
    "graph_neighbors",
    "list_all_tags",
    "list_directory",
    "manage_tags",
    "move_file",
    "move_note",
    "note_links",
    "patch_note",
    "read_multiple_notes",
    "read_note",
    "rename_note_with_links",
    "search_notes",
    "update_frontmatter",
    "wiki_link",
    "write_note",
  ]);

  await client.close();
  await server.close();
});

test("server can read and write notes via tools", async () => {
  const server = createServer(testVaultPath, { version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  const client = new Client({ name: "test-client", version: "1.0.0" });

  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);

  // Write a note
  await client.callTool({ name: "write_note", arguments: { path: "test.md", content: "# Hello World" } });

  // Read it back
  const result = await client.callTool({ name: "read_note", arguments: { path: "test.md" } });
  const parsed = JSON.parse((result.content as any)[0].text);
  expect(parsed.content).toContain("Hello World");

  await client.close();
  await server.close();
});

test("custom options are applied", () => {
  const server = createServer(testVaultPath, {
    name: "custom-name",
    version: "2.0.0",
  });
  expect(server).toBeDefined();
});

async function connectClient() {
  const server = createServer(testVaultPath, { version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  return { server, client };
}

test("wiki_link returns isError on invalid syntax (backslash in parsed)", async () => {
  const { server, client } = await connectClient();
  try {
    const result = await client.callTool({
      name: "wiki_link",
      arguments: { document: "[[Foo\\\\|Bar]]" },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as any)[0].text as string;
    expect(text).toMatch(/Invalid wiki-link syntax/);
    expect((result.structuredContent as any).rawInput).toBe("[[Foo\\\\|Bar]]");
  } finally {
    await client.close();
    await server.close();
  }
});

test("wiki_link returns isError on zero match with document echo", async () => {
  const { server, client } = await connectClient();
  try {
    await writeFile(join(testVaultPath, "Other.md"), "# Other");
    const result = await client.callTool({
      name: "wiki_link",
      arguments: { document: "Missing" },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as any)[0].text as string;
    expect(text).toContain("Missing");
    expect(text).toContain("search_notes");
    const sc = result.structuredContent as any;
    expect(sc.document).toBe("Missing");
  } finally {
    await client.close();
    await server.close();
  }
});

test("wiki_link single match omits alternatives", async () => {
  const { server, client } = await connectClient();
  try {
    await writeFile(join(testVaultPath, "Note.md"), "# Note\n\nbody");
    const result = await client.callTool({
      name: "wiki_link",
      arguments: { document: "Note" },
    });
    expect(result.isError).toBeFalsy();
    const sc = result.structuredContent as any;
    expect(sc.document).toBe("Note");
    expect(sc.path).toBe("Note.md");
    expect("alternatives" in sc).toBe(false);
    expect(sc.ambiguous).toBeUndefined();
    expect(sc.matches).toBeUndefined();
  } finally {
    await client.close();
    await server.close();
  }
});

test("wiki_link multi match resolves first sorted path and lists alternatives", async () => {
  const { server, client } = await connectClient();
  try {
    await writeFile(join(testVaultPath, "Note.md"), "# Root Note");
    await mkdir(join(testVaultPath, "deep"), { recursive: true });
    await writeFile(join(testVaultPath, "deep/Note.md"), "# Deep Note");
    const result = await client.callTool({
      name: "wiki_link",
      arguments: { document: "[[Note]]" },
    });
    expect(result.isError).toBeFalsy();
    const sc = result.structuredContent as any;
    expect(sc.path).toBe("Note.md");
    expect(sc.alternatives).toEqual(["deep/Note.md"]);
    expect(sc.ambiguous).toBeUndefined();
    expect(sc.matches).toBeUndefined();
  } finally {
    await client.close();
    await server.close();
  }
});

test("wiki_link unescapes table-authored \\| inside brackets", async () => {
  const { server, client } = await connectClient();
  try {
    await writeFile(join(testVaultPath, "My Document.md"), "# My Document\n\ncontent");
    const result = await client.callTool({
      name: "wiki_link",
      arguments: { document: "[[My Document\\|Displayed]]" },
    });
    expect(result.isError).toBeFalsy();
    const sc = result.structuredContent as any;
    expect(sc.document).toBe("My Document");
    expect(sc.path).toBe("My Document.md");
  } finally {
    await client.close();
    await server.close();
  }
});

test("wiki_link resolves path-qualified link to the exact file", async () => {
  const { server, client } = await connectClient();
  try {
    await writeFile(join(testVaultPath, "Note.md"), "# Root Note");
    await mkdir(join(testVaultPath, "deep"), { recursive: true });
    await writeFile(join(testVaultPath, "deep/Note.md"), "# Deep Note");
    const result = await client.callTool({
      name: "wiki_link",
      arguments: { document: "[[deep/Note]]" },
    });
    expect(result.isError).toBeFalsy();
    const sc = result.structuredContent as any;
    expect(sc.document).toBe("deep/Note");
    expect(sc.path).toBe("deep/Note.md");
    expect("alternatives" in sc).toBe(false);
  } finally {
    await client.close();
    await server.close();
  }
});

// ── Tool annotations ─────────────────────────────────────────────────────────
// Without annotations a client cannot tell delete_note apart from read_note:
// MCP proxies derive the call variant from these hints, and an unannotated tool
// falls back to whatever default that proxy picked.

test("every tool carries annotations and stays closed-world", async () => {
  const server = createServer(process.cwd());
  // @ts-expect-error — reaching into the registered ListTools handler
  const { tools } = await server._requestHandlers.get("tools/list")({ method: "tools/list", params: {} }, {});

  expect(tools.length).toBeGreaterThan(0);
  for (const tool of tools) {
    expect(tool.annotations, `${tool.name} has no annotations`).toBeDefined();
    expect(tool.annotations.openWorldHint, `${tool.name} should be closed-world`).toBe(false);
  }
});

test("destructive and read-only tools are marked as such", async () => {
  const server = createServer(process.cwd());
  // @ts-expect-error — reaching into the registered ListTools handler
  const { tools } = await server._requestHandlers.get("tools/list")({ method: "tools/list", params: {} }, {});
  const byName = Object.fromEntries(tools.map((t: any) => [t.name, t.annotations]));

  expect(byName.delete_note.destructiveHint).toBe(true);
  expect(byName.delete_note.readOnlyHint).toBe(false);

  expect(byName.read_note.readOnlyHint).toBe(true);
  expect(byName.search_notes.readOnlyHint).toBe(true);
  expect(byName.wiki_link.readOnlyHint).toBe(true);

  // mutating, but must not be reported as destructive
  expect(byName.write_note.readOnlyHint).toBe(false);
  expect(byName.write_note.destructiveHint).toBe(false);
  expect(byName.patch_note.destructiveHint).toBe(false);
});

// ── Graph tools ──────────────────────────────────────────────────────────────

async function seedGraph() {
  const { writeFile, mkdir } = await import("fs/promises");
  const { join, dirname } = await import("path");
  const put = async (rel: string, body: string) => {
    const full = join(testVaultPath, rel);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, body, "utf-8");
  };
  await put("hub.md", "Links to [[leaf]] and [[ghost]].");
  await put("inbound.md", "Points at [[hub]].");
  await put("leaf.md", "A leaf.");
  await put("lonely.md", "Nobody links here.");
}

test("note_links reports outgoing, backlinks and unresolved", async () => {
  await seedGraph();
  const { server, client } = await connectClient();
  try {
    const result: any = await client.callTool({ name: "note_links", arguments: { path: "hub.md" } });
    const payload = JSON.parse(result.content[0].text);

    expect(payload.outgoing.map((o: any) => o.path)).toEqual(["leaf.md"]);
    expect(payload.backlinks).toEqual(["inbound.md"]);
    expect(payload.unresolved).toEqual(["ghost"]);
  } finally {
    await client.close();
    await server.close();
  }
});

test("find_broken_links reports the dangling target and orphans on request", async () => {
  await seedGraph();
  const { server, client } = await connectClient();
  try {
    const result: any = await client.callTool({
      name: "find_broken_links",
      arguments: { includeOrphans: true },
    });
    const payload = JSON.parse(result.content[0].text);

    expect(payload.brokenLinks).toEqual([{ from: "hub.md", target: "ghost" }]);
    expect(payload.totalBroken).toBe(1);
    expect(payload.orphans).toContain("lonely.md");
    expect(payload.orphans).not.toContain("leaf.md");
  } finally {
    await client.close();
    await server.close();
  }
});

test("graph_neighbors walks both directions", async () => {
  await seedGraph();
  const { server, client } = await connectClient();
  try {
    const result: any = await client.callTool({
      name: "graph_neighbors",
      arguments: { path: "hub.md", depth: 1 },
    });
    const payload = JSON.parse(result.content[0].text);

    expect(payload.nodes.sort()).toEqual(["hub.md", "inbound.md", "leaf.md"]);
  } finally {
    await client.close();
    await server.close();
  }
});

test("rename_note_with_links moves the note and fixes references", async () => {
  await seedGraph();
  const { readFile } = await import("fs/promises");
  const { join } = await import("path");
  const { server, client } = await connectClient();
  try {
    const result: any = await client.callTool({
      name: "rename_note_with_links",
      arguments: { oldPath: "leaf.md", newPath: "renamed-leaf.md" },
    });
    const payload = JSON.parse(result.content[0].text);

    expect(payload.updatedNotes).toEqual(["hub.md"]);
    const hub = await readFile(join(testVaultPath, "hub.md"), "utf-8");
    expect(hub).toContain("[[renamed-leaf]]");
    expect(hub).not.toContain("[[leaf]]");
  } finally {
    await client.close();
    await server.close();
  }
});

test("rename_note_with_links dryRun changes nothing", async () => {
  await seedGraph();
  const { readFile } = await import("fs/promises");
  const { join } = await import("path");
  const { server, client } = await connectClient();
  try {
    const result: any = await client.callTool({
      name: "rename_note_with_links",
      arguments: { oldPath: "leaf.md", newPath: "renamed-leaf.md", dryRun: true },
    });
    const payload = JSON.parse(result.content[0].text);

    expect(payload.wouldUpdate).toEqual(["hub.md"]);
    const hub = await readFile(join(testVaultPath, "hub.md"), "utf-8");
    expect(hub).toContain("[[leaf]]");
  } finally {
    await client.close();
    await server.close();
  }
});
