import { join, resolve } from 'path';
import { readFile, readdir, stat } from 'node:fs/promises';
/** Strip fenced blocks and inline code so their contents are not mistaken for links. */
function stripCode(content) {
    return content
        .replace(/^```[\s\S]*?^```/gm, '')
        .replace(/```[\s\S]*?```/g, '')
        .replace(/`[^`\n]*`/g, '');
}
/** Normalize a wiki-link target: drop display text and #fragment, unescape \|. */
function cleanWikiTarget(inner) {
    let text = inner.replace(/\\\|/g, '|');
    const pipe = text.indexOf('|');
    if (pipe !== -1)
        text = text.slice(0, pipe);
    const hash = text.indexOf('#');
    if (hash !== -1)
        text = text.slice(0, hash);
    return text.trim();
}
const WIKILINK_RE = /\[\[([^\[\]]+)\]\]/g;
const MDLINK_RE = /\[[^\]]*\]\(([^)\s]+)\)/g;
/** Extract every internal link from note content, in source order. */
export function extractLinks(content) {
    const body = stripCode(content);
    const found = [];
    for (const m of body.matchAll(WIKILINK_RE)) {
        const target = cleanWikiTarget(m[1] ?? '');
        if (target)
            found.push({ target, raw: m[0], kind: 'wikilink' });
    }
    for (const m of body.matchAll(MDLINK_RE)) {
        const href = m[1];
        if (!href)
            continue;
        // Only vault-internal markdown links: skip URLs, anchors and mailto.
        if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('#') || href.startsWith('//')) {
            continue;
        }
        const target = decodeURIComponent(href.split('#')[0] ?? '').trim();
        if (target)
            found.push({ target, raw: m[0], kind: 'markdown' });
    }
    return found;
}
/** Split content into segments, marking the ones that are code and must stay untouched. */
function segmentByCode(content) {
    const segments = [];
    const re = /(```[\s\S]*?```|`[^`\n]*`)/g;
    let last = 0;
    for (const m of content.matchAll(re)) {
        const start = m.index;
        if (start > last)
            segments.push({ text: content.slice(last, start), isCode: false });
        segments.push({ text: m[0], isCode: true });
        last = start + m[0].length;
    }
    if (last < content.length)
        segments.push({ text: content.slice(last), isCode: false });
    return segments;
}
/**
 * Rewrite every link pointing at `oldPath` so it points at `newPath`.
 *
 * The shape of each link is preserved: a bare `[[Name]]` stays bare, a
 * path-qualified `[[folder/Name]]` stays qualified, display text and #fragments
 * survive, and links inside code are left alone. Without this, renaming a note
 * through the MCP server silently breaks every reference to it.
 */
export function rewriteLinksTo(content, oldPath, newPath) {
    const oldNoExt = oldPath.replace(/\.md$/i, '');
    const newNoExt = newPath.replace(/\.md$/i, '');
    const oldBase = oldNoExt.slice(oldNoExt.lastIndexOf('/') + 1);
    const newBase = newNoExt.slice(newNoExt.lastIndexOf('/') + 1);
    return segmentByCode(content)
        .map(({ text, isCode }) => {
        if (isCode)
            return text;
        let out = text.replace(WIKILINK_RE, (raw, inner) => {
            const target = cleanWikiTarget(inner);
            if (target === oldNoExt)
                return raw.replace(target, newNoExt);
            if (!target.includes('/') && target === oldBase)
                return raw.replace(target, newBase);
            return raw;
        });
        out = out.replace(MDLINK_RE, (raw, href) => {
            if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('#') || href.startsWith('//')) {
                return raw;
            }
            const [pathPart, frag] = href.split('#');
            const decoded = decodeURIComponent(pathPart ?? '');
            if (decoded !== oldPath && decoded.replace(/\.md$/i, '') !== oldNoExt)
                return raw;
            const replacement = frag ? `${newPath}#${frag}` : newPath;
            return raw.replace(href, replacement);
        });
        return out;
    })
        .join('');
}
/**
 * An in-memory index of the vault's link graph.
 *
 * Built once and refreshed incrementally: a note is re-read only when its mtime
 * or size changed, so repeated graph queries do not re-read the whole vault.
 * That matters when the vault is a network mount — a full scan of ~500 notes
 * over s3fs costs seconds, and every graph tool would otherwise pay it again.
 */
export class LinkIndex {
    pathFilter;
    vaultPath;
    entries = new Map();
    /** basename (without .md) → vault-relative paths, sorted root-first then alphabetically. */
    byBasename = new Map();
    constructor(vaultPath, pathFilter) {
        this.pathFilter = pathFilter;
        this.vaultPath = resolve(vaultPath);
    }
    /** Rescan the vault, reusing cached entries for notes that did not change. */
    async refresh() {
        const files = await this.findNotes(this.vaultPath);
        const seen = new Set();
        let parsed = 0;
        let reused = 0;
        // Resolution needs the full file list, so build the basename map first.
        this.byBasename = new Map();
        for (const rel of files) {
            const base = rel.slice(rel.lastIndexOf('/') + 1).replace(/\.md$/i, '');
            const list = this.byBasename.get(base);
            if (list)
                list.push(rel);
            else
                this.byBasename.set(base, [rel]);
        }
        for (const list of this.byBasename.values()) {
            list.sort(compareRootFirst);
        }
        for (const rel of files) {
            seen.add(rel);
            const full = join(this.vaultPath, rel);
            let mtimeMs = 0;
            let size = 0;
            try {
                const st = await stat(full);
                mtimeMs = st.mtimeMs;
                size = st.size;
            }
            catch {
                continue;
            }
            const cached = this.entries.get(rel);
            if (cached && cached.mtimeMs === mtimeMs && cached.size === size) {
                reused++;
            }
            else {
                let content = '';
                try {
                    content = await readFile(full, 'utf-8');
                }
                catch {
                    continue;
                }
                this.entries.set(rel, {
                    mtimeMs,
                    size,
                    links: extractLinks(content).map((l) => ({ ...l, resolved: null })),
                });
                parsed++;
            }
        }
        for (const rel of [...this.entries.keys()]) {
            if (!seen.has(rel))
                this.entries.delete(rel);
        }
        // Targets are resolved against the current file list on every refresh:
        // adding or deleting a note can fix or break links in notes that did not change.
        for (const entry of this.entries.values()) {
            for (const link of entry.links) {
                link.resolved = this.resolve(link.target);
            }
        }
        return { parsed, reused, total: this.entries.size };
    }
    /** Resolve a link target to a vault-relative path, or null when nothing matches. */
    resolve(target) {
        const withoutExt = target.replace(/\.md$/i, '');
        if (target.includes('/')) {
            const wanted = `${withoutExt}.md`;
            return this.hasPath(wanted) ? wanted : null;
        }
        return this.byBasename.get(withoutExt)?.[0] ?? null;
    }
    hasPath(rel) {
        const base = rel.slice(rel.lastIndexOf('/') + 1).replace(/\.md$/i, '');
        return (this.byBasename.get(base) || []).includes(rel);
    }
    allPaths() {
        return [...this.entries.keys()].sort();
    }
    getOutgoing(path) {
        return this.entries.get(path)?.links ?? [];
    }
    getBacklinks(path) {
        const refs = [];
        for (const [from, entry] of this.entries) {
            if (from === path)
                continue;
            for (const link of entry.links) {
                if (link.resolved === path)
                    refs.push({ from, raw: link.raw });
            }
        }
        return refs.sort((a, b) => a.from.localeCompare(b.from));
    }
    getBroken(pathPrefix) {
        const broken = [];
        for (const [from, entry] of this.entries) {
            if (pathPrefix && !(from === pathPrefix || from.startsWith(pathPrefix + '/')))
                continue;
            for (const link of entry.links) {
                if (link.resolved === null)
                    broken.push({ from, target: link.target, raw: link.raw });
            }
        }
        return broken.sort((a, b) => a.from.localeCompare(b.from) || a.target.localeCompare(b.target));
    }
    /** Notes nothing links to. */
    getOrphans(pathPrefix) {
        const linked = new Set();
        for (const entry of this.entries.values()) {
            for (const link of entry.links) {
                if (link.resolved)
                    linked.add(link.resolved);
            }
        }
        return this.allPaths().filter((p) => !linked.has(p) &&
            (!pathPrefix || p === pathPrefix || p.startsWith(pathPrefix + '/')));
    }
    /** Sub-graph around a note, following links in both directions up to `depth` hops. */
    getNeighbors(path, depth = 1) {
        const nodes = new Set([path]);
        const edges = [];
        const seenEdge = new Set();
        let frontier = [path];
        for (let d = 0; d < Math.max(1, depth); d++) {
            const next = [];
            for (const current of frontier) {
                for (const link of this.getOutgoing(current)) {
                    if (!link.resolved)
                        continue;
                    addEdge(current, link.resolved);
                    if (!nodes.has(link.resolved)) {
                        nodes.add(link.resolved);
                        next.push(link.resolved);
                    }
                }
                for (const back of this.getBacklinks(current)) {
                    addEdge(back.from, current);
                    if (!nodes.has(back.from)) {
                        nodes.add(back.from);
                        next.push(back.from);
                    }
                }
            }
            frontier = next;
            if (frontier.length === 0)
                break;
        }
        function addEdge(from, to) {
            const key = `${from} ${to}`;
            if (seenEdge.has(key))
                return;
            seenEdge.add(key);
            edges.push({ from, to });
        }
        return { nodes: [...nodes], edges };
    }
    async findNotes(dirPath, relativePath = '') {
        const out = [];
        let entries;
        try {
            entries = await readdir(dirPath, { withFileTypes: true });
        }
        catch {
            return out;
        }
        for (const entry of entries) {
            const rel = relativePath ? `${relativePath}/${entry.name}` : entry.name;
            if (!this.pathFilter.isAllowed(rel))
                continue;
            if (entry.isDirectory()) {
                if (!this.pathFilter.isAllowed(`${rel}/test.md`))
                    continue;
                out.push(...(await this.findNotes(join(dirPath, entry.name), rel)));
            }
            else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
                out.push(rel);
            }
        }
        return out;
    }
}
/** Vault root first, then alphabetically — same tie-break as findPathForWikiLink. */
function compareRootFirst(a, b) {
    const da = a.includes('/') ? 1 : 0;
    const db = b.includes('/') ? 1 : 0;
    if (da !== db)
        return da - db;
    return a.localeCompare(b);
}
