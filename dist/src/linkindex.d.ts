import type { PathFilter } from './pathfilter.js';
/** A single link found in a note. */
export interface OutgoingLink {
    /** Target as written, minus brackets, display text and #fragment. */
    target: string;
    /** The link exactly as it appears in the source. */
    raw: string;
    kind: 'wikilink' | 'markdown';
    /** Vault-relative path this target resolves to, or null when nothing matches. */
    resolved: string | null;
}
export interface BacklinkRef {
    from: string;
    raw: string;
}
export interface BrokenLink {
    from: string;
    target: string;
    raw: string;
}
export interface NeighborGraph {
    nodes: string[];
    edges: {
        from: string;
        to: string;
    }[];
}
export interface RefreshStats {
    /** Notes read and parsed during this refresh. */
    parsed: number;
    /** Notes served from cache because mtime and size were unchanged. */
    reused: number;
    total: number;
}
/** Extract every internal link from note content, in source order. */
export declare function extractLinks(content: string): Omit<OutgoingLink, 'resolved'>[];
/**
 * Rewrite every link pointing at `oldPath` so it points at `newPath`.
 *
 * The shape of each link is preserved: a bare `[[Name]]` stays bare, a
 * path-qualified `[[folder/Name]]` stays qualified, display text and #fragments
 * survive, and links inside code are left alone. Without this, renaming a note
 * through the MCP server silently breaks every reference to it.
 */
export declare function rewriteLinksTo(content: string, oldPath: string, newPath: string): string;
/**
 * An in-memory index of the vault's link graph.
 *
 * Built once and refreshed incrementally: a note is re-read only when its mtime
 * or size changed, so repeated graph queries do not re-read the whole vault.
 * That matters when the vault is a network mount — a full scan of ~500 notes
 * over s3fs costs seconds, and every graph tool would otherwise pay it again.
 */
export declare class LinkIndex {
    private pathFilter;
    private vaultPath;
    private entries;
    /** basename (without .md) → vault-relative paths, sorted root-first then alphabetically. */
    private byBasename;
    /** Every known note path — used for suffix matching during resolution. */
    private allPathsCache;
    constructor(vaultPath: string, pathFilter: PathFilter);
    /** Rescan the vault, reusing cached entries for notes that did not change. */
    refresh(): Promise<RefreshStats>;
    /**
     * Resolve a link target to a vault-relative path, or null when nothing matches.
     *
     * Mirrors how Obsidian resolves a qualified link, which is NOT "vault-relative
     * only": `[[Knowledge/note]]` written inside `Dev/B24/` points at
     * `Dev/B24/Knowledge/note.md`, and a partial path is allowed to match the tail
     * of a longer one. Treating those as unresolved reports healthy links as broken.
     *
     * Order: exact vault-relative → relative to the linking note's folder →
     * unique path suffix → basename.
     */
    resolve(target: string, fromPath?: string): string | null;
    private hasPath;
    allPaths(): string[];
    getOutgoing(path: string): OutgoingLink[];
    getBacklinks(path: string): BacklinkRef[];
    getBroken(pathPrefix?: string): BrokenLink[];
    /** Notes nothing links to. */
    getOrphans(pathPrefix?: string): string[];
    /** Sub-graph around a note, following links in both directions up to `depth` hops. */
    getNeighbors(path: string, depth?: number): NeighborGraph;
    private findNotes;
}
//# sourceMappingURL=linkindex.d.ts.map