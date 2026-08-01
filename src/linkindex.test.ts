import { test, expect, beforeEach, afterEach, describe } from "vitest";
import { LinkIndex, rewriteLinksTo } from "./linkindex.js";
import { PathFilter } from "./pathfilter.js";
import { writeFile, mkdir, mkdtemp, rm, utimes } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

let vault: string;

async function note(relPath: string, body: string): Promise<void> {
  const full = join(vault, relPath);
  const dir = full.slice(0, Math.max(full.lastIndexOf("/"), full.lastIndexOf("\\")));
  await mkdir(dir, { recursive: true });
  await writeFile(full, body, "utf-8");
}

beforeEach(async () => {
  vault = await mkdtemp(join(tmpdir(), "mcpvault-index-"));
});

afterEach(async () => {
  try {
    await rm(vault, { recursive: true });
  } catch {
    // ignore
  }
});

function index(): LinkIndex {
  return new LinkIndex(vault, new PathFilter());
}

describe("link extraction", () => {
  test("collects wiki links, embeds and relative markdown links", async () => {
    await note("a.md", [
      "Plain [[b]] link.",
      "With display [[c|see c]] and heading [[d#Section]].",
      "Embed ![[e]].",
      "Markdown [label](f.md) and [nested](sub/g.md).",
      "External [site](https://example.com) must be ignored.",
    ].join("\n"));
    await note("b.md", "");
    await note("c.md", "");
    await note("d.md", "");
    await note("e.md", "");
    await note("f.md", "");
    await note("sub/g.md", "");

    const idx = index();
    await idx.refresh();

    const targets = idx.getOutgoing("a.md").map((l) => l.target).sort();
    expect(targets).toEqual(["b", "c", "d", "e", "f.md", "sub/g.md"]);
    expect(idx.getOutgoing("a.md").every((l) => l.resolved !== null)).toBe(true);
  });

  test("ignores links inside fenced and inline code", async () => {
    await note("a.md", [
      "Real [[b]].",
      "```",
      "not a link [[ghost]]",
      "```",
      "Inline `[[alsoghost]]` too.",
    ].join("\n"));
    await note("b.md", "");

    const idx = index();
    await idx.refresh();

    expect(idx.getOutgoing("a.md").map((l) => l.target)).toEqual(["b"]);
  });
});

describe("resolution", () => {
  test("resolves by basename and prefers vault root on ties", async () => {
    await note("a.md", "[[dup]]");
    await note("dup.md", "");
    await note("sub/dup.md", "");

    const idx = index();
    await idx.refresh();

    expect(idx.getOutgoing("a.md")[0].resolved).toBe("dup.md");
  });

  test("path-qualified links resolve to the exact path", async () => {
    await note("a.md", "[[sub/dup]]");
    await note("dup.md", "");
    await note("sub/dup.md", "");

    const idx = index();
    await idx.refresh();

    expect(idx.getOutgoing("a.md")[0].resolved).toBe("sub/dup.md");
  });

  test("unresolvable links are reported, not dropped", async () => {
    await note("a.md", "[[nowhere]]");

    const idx = index();
    await idx.refresh();

    const link = idx.getOutgoing("a.md")[0];
    expect(link.target).toBe("nowhere");
    expect(link.resolved).toBeNull();
  });
});

describe("backlinks, broken links and orphans", () => {
  test("backlinks are the inverse of outgoing links", async () => {
    await note("a.md", "[[target]]");
    await note("sub/b.md", "also [[target]]");
    await note("target.md", "");

    const idx = index();
    await idx.refresh();

    expect(idx.getBacklinks("target.md").map((b) => b.from).sort()).toEqual(["a.md", "sub/b.md"]);
    expect(idx.getBacklinks("a.md")).toEqual([]);
  });

  test("broken links list source and target", async () => {
    await note("a.md", "[[ghost]] and [[real]]");
    await note("real.md", "");

    const idx = index();
    await idx.refresh();

    const broken = idx.getBroken();
    expect(broken).toHaveLength(1);
    expect(broken[0].from).toBe("a.md");
    expect(broken[0].target).toBe("ghost");
  });

  test("orphans have no incoming links", async () => {
    await note("linked.md", "");
    await note("lonely.md", "");
    await note("a.md", "[[linked]]");

    const idx = index();
    await idx.refresh();

    const orphans = idx.getOrphans();
    expect(orphans).toContain("lonely.md");
    expect(orphans).not.toContain("linked.md");
  });
});

describe("neighbors", () => {
  test("depth 1 returns direct links in both directions", async () => {
    await note("hub.md", "[[out]]");
    await note("in.md", "[[hub]]");
    await note("out.md", "");
    await note("far.md", "[[in]]");

    const idx = index();
    await idx.refresh();

    const g = idx.getNeighbors("hub.md", 1);
    expect(g.nodes.sort()).toEqual(["hub.md", "in.md", "out.md"]);
  });

  test("depth 2 reaches one hop further", async () => {
    await note("hub.md", "[[out]]");
    await note("out.md", "[[far]]");
    await note("far.md", "");

    const idx = index();
    await idx.refresh();

    const g = idx.getNeighbors("hub.md", 2);
    expect(g.nodes.sort()).toEqual(["far.md", "hub.md", "out.md"]);
    expect(g.edges).toContainEqual({ from: "hub.md", to: "out.md" });
    expect(g.edges).toContainEqual({ from: "out.md", to: "far.md" });
  });
});

describe("incremental refresh", () => {
  test("second refresh reuses cached entries and picks up changes", async () => {
    await note("a.md", "[[b]]");
    await note("b.md", "");

    const idx = index();
    const first = await idx.refresh();
    expect(first.parsed).toBe(2);
    expect(first.reused).toBe(0);

    const second = await idx.refresh();
    expect(second.parsed).toBe(0);
    expect(second.reused).toBe(2);

    // touch a.md with new content and a newer mtime
    await note("a.md", "[[b]] and [[c]]");
    const future = new Date(Date.now() + 2000);
    await utimes(join(vault, "a.md"), future, future);

    const third = await idx.refresh();
    expect(third.parsed).toBe(1);
    expect(idx.getOutgoing("a.md")).toHaveLength(2);
  });

  test("deleted notes drop out of the index", async () => {
    await note("a.md", "[[b]]");
    await note("b.md", "");

    const idx = index();
    await idx.refresh();
    expect(idx.allPaths().sort()).toEqual(["a.md", "b.md"]);

    await rm(join(vault, "b.md"));
    await idx.refresh();

    expect(idx.allPaths()).toEqual(["a.md"]);
    expect(idx.getBroken()[0].target).toBe("b");
  });
});

describe("rewriteLinksTo", () => {
  test("renames wiki links while keeping display text and fragments", () => {
    const body = "See [[Old Note]], [[Old Note|the old one]] and [[Old Note#Section]].";

    const out = rewriteLinksTo(body, "Old Note.md", "New Note.md");

    expect(out).toBe("See [[New Note]], [[New Note|the old one]] and [[New Note#Section]].");
  });

  test("keeps path-qualified links qualified", () => {
    const body = "Link to [[sub/Old]] here.";

    const out = rewriteLinksTo(body, "sub/Old.md", "other/New.md");

    expect(out).toBe("Link to [[other/New]] here.");
  });

  test("rewrites markdown links", () => {
    const body = "A [label](sub/Old.md) link.";

    const out = rewriteLinksTo(body, "sub/Old.md", "other/New.md");

    expect(out).toBe("A [label](other/New.md) link.");
  });

  test("leaves unrelated links alone", () => {
    const body = "[[Other]] and [[Old Notebook]] and [x](https://old.example/Old.md)";

    const out = rewriteLinksTo(body, "Old.md", "New.md");

    expect(out).toBe(body);
  });

  test("does not touch links inside code blocks", () => {
    const body = ["Real [[Old]].", "```", "[[Old]]", "```"].join("\n");

    const out = rewriteLinksTo(body, "Old.md", "New.md");

    expect(out).toBe(["Real [[New]].", "```", "[[Old]]", "```"].join("\n"));
  });

  test("embeds are renamed too", () => {
    const out = rewriteLinksTo("![[Old]]", "Old.md", "New.md");

    expect(out).toBe("![[New]]");
  });
});

describe("Obsidian-style path resolution", () => {
  test("resolves a link relative to the linking note's folder", async () => {
    await note("Dev/B24/Handoff.md", "See [[Knowledge/harness]].");
    await note("Dev/B24/Knowledge/harness.md", "");

    const idx = index();
    await idx.refresh();

    expect(idx.getOutgoing("Dev/B24/Handoff.md")[0].resolved).toBe("Dev/B24/Knowledge/harness.md");
    expect(idx.getBroken()).toEqual([]);
  });

  test("resolves a partial path suffix from anywhere in the vault", async () => {
    await note("top.md", "See [[Knowledge/harness]].");
    await note("Dev/B24/Knowledge/harness.md", "");

    const idx = index();
    await idx.refresh();

    expect(idx.getOutgoing("top.md")[0].resolved).toBe("Dev/B24/Knowledge/harness.md");
  });

  test("an exact vault-relative path still wins over a suffix match", async () => {
    await note("a.md", "[[Knowledge/harness]]");
    await note("Knowledge/harness.md", "");
    await note("Deep/Knowledge/harness.md", "");

    const idx = index();
    await idx.refresh();

    expect(idx.getOutgoing("a.md")[0].resolved).toBe("Knowledge/harness.md");
  });

  test("a genuinely missing qualified target stays broken", async () => {
    await note("a.md", "[[Nope/missing]]");

    const idx = index();
    await idx.refresh();

    expect(idx.getOutgoing("a.md")[0].resolved).toBeNull();
  });
});
