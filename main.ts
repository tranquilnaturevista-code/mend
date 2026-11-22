// main.ts is mend, the CLI SPEC.md specifies: one command-line tool that applies
// AI-written edits in four formats (unified diff, SEARCH/REPLACE, V4A, JSON) to a tree
// of text files, all or nothing. Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then
// this file hands over to runner.ts (the last lines below): keep that hand-over and
// runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => { move?: [string, string] } | void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------------------------------------------------------------------------
// Section 3: a file's lines, its line break and its final line break.
// ---------------------------------------------------------------------------

interface FileParts {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileParts {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

// ---------------------------------------------------------------------------
// Section 5: matching lines at three tiers.
// ---------------------------------------------------------------------------

/** One line of O or N. `ctx` lines are in both: they are written as the file's own line. */
interface OLine {
  text: string;
  ctx: boolean;
}

const trimEndWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadingWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndWs(a) === trimEndWs(b);
  return trimWs(a) === trimWs(b);
}

/** 0-based positions at which O occurs in `lines` at `tier`, at or after `from`. */
function occurrences(lines: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = from; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (!lineEq(lines[i + j]!, o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at or after `from`, with its occurrences. */
function findTier(lines: string[], o: string[], from: number, strict: boolean): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(lines, o, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** The lines N writes when O matched the file at `at`, at `tier`. */
function buildReplacement(fileLines: string[], o: OLine[], n: OLine[], at: number, tier: number): string[] {
  const oCtx: number[] = [];
  o.forEach((x, idx) => {
    if (x.ctx) oCtx.push(idx);
  });
  const f = leadingWs(fileLines[at] ?? '');
  const p = leadingWs(o.length > 0 ? o[0]!.text : '');
  const out: string[] = [];
  let cj = 0;
  for (const item of n) {
    if (item.ctx) {
      out.push(fileLines[at + oCtx[cj]!]!);
      cj++;
    } else if (tier === 2) {
      const line = item.text;
      out.push(/^[ \t]*$/.test(line) || !line.startsWith(p) ? line : f + line.slice(p.length));
    } else {
      out.push(item.text);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Section 9: JSON edits.
// ---------------------------------------------------------------------------

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Section 6: unified diffs.
// ---------------------------------------------------------------------------

interface Hunk {
  a: number;
  o: OLine[];
  n: OLine[];
  /** A `\` line follows the hunk's last context or `+` line. */
  noEol: boolean;
  /** A `\` line follows the hunk's last `+` line. */
  plusNoEol: boolean;
}

interface UniSection {
  diffOld: string | undefined;
  diffNew: string | undefined;
  pairOld: string | null | undefined;
  pairNew: string | null | undefined;
  renOld: string | undefined;
  renNew: string | undefined;
  newFile: boolean;
  delFile: boolean;
  hunks: Hunk[];
}

function stripAB(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

/** The path a `--- ` or `+++ ` line names, or null for `/dev/null`. */
function headerPath(l: string): string | null {
  const t = l.slice(4).split('\t')[0]!.trim();
  if (t === '/dev/null') return null;
  return stripAB(t);
}

function finishHunk(a: number, body: string[]): Hunk {
  while (body.length > 0 && body[body.length - 1] === '') body.pop();
  const o: OLine[] = [];
  const n: OLine[] = [];
  let lastCtxPlus = -1;
  let lastPlus = -1;
  for (let k = 0; k < body.length; k++) {
    const l = body[k]!;
    if (l[0] === ' ') {
      o.push({ text: l.slice(1), ctx: true });
      n.push({ text: l.slice(1), ctx: true });
      lastCtxPlus = k;
    } else if (l[0] === '-') {
      o.push({ text: l.slice(1), ctx: false });
    } else if (l[0] === '+') {
      n.push({ text: l.slice(1), ctx: false });
      lastCtxPlus = k;
      lastPlus = k;
    } else if (l === '') {
      o.push({ text: '', ctx: true });
      n.push({ text: '', ctx: true });
      lastCtxPlus = k;
    }
    // A `\` line refers to the body line before it; it adds no line of its own.
  }
  const noEol = lastCtxPlus >= 0 && body[lastCtxPlus + 1] !== undefined && body[lastCtxPlus + 1]![0] === '\\';
  const plusNoEol = lastPlus >= 0 && body[lastPlus + 1] !== undefined && body[lastPlus + 1]![0] === '\\';
  return { a, o, n, noEol, plusNoEol };
}

function parseUnified(lines: string[]): UniSection[] {
  const sections: UniSection[] = [];
  let s: UniSection | null = null;
  let inHeader = false;
  let pairDone = false;
  let hunk: { a: number; body: string[] } | null = null;

  const flushHunk = (): void => {
    if (hunk !== null && s !== null) {
      s.hunks.push(finishHunk(hunk.a, hunk.body));
      hunk = null;
    }
  };
  const newSection = (): UniSection => {
    flushHunk();
    const ns: UniSection = {
      diffOld: undefined,
      diffNew: undefined,
      pairOld: undefined,
      pairNew: undefined,
      renOld: undefined,
      renNew: undefined,
      newFile: false,
      delFile: false,
      hunks: [],
    };
    sections.push(ns);
    s = ns;
    inHeader = true;
    pairDone = false;
    return ns;
  };
  /** A body line, except that a `--- ` line followed by a `+++ ` line ends the body. */
  const isBodyLine = (l: string, next: string | undefined): boolean => {
    if (l === '') return true;
    if (l.startsWith('--- ') && next !== undefined && next.startsWith('+++ ')) return false;
    const c = l[0];
    return c === ' ' || c === '-' || c === '+' || c === '\\';
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (hunk !== null) {
      if (isBodyLine(line, lines[i + 1])) {
        hunk.body.push(line);
        continue;
      }
      flushHunk();
    }
    if (line === 'diff --git' || line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const ns = newSection();
      ns.diffOld = m[1]!;
      ns.diffNew = m[2]!;
      continue;
    }
    if (line.startsWith('--- ')) {
      const next = lines[i + 1];
      if (next !== undefined && next.startsWith('+++ ')) {
        if (s !== null && inHeader && !pairDone) {
          s.pairOld = headerPath(line);
          s.pairNew = headerPath(next);
          pairDone = true;
        } else {
          const ns = newSection();
          ns.pairOld = headerPath(line);
          ns.pairNew = headerPath(next);
          pairDone = true;
        }
        i++;
        continue;
      }
      if (s !== null && inHeader) throw new Exit2(`error: parse ${i + 2}`);
      continue;
    }
    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m === null || s === null) throw new Exit2(`error: parse ${i + 1}`);
      inHeader = false;
      hunk = { a: Number(m[1]), body: [] };
      continue;
    }
    if (s !== null && inHeader) {
      if (line.startsWith('rename from ')) {
        if (s.renOld === undefined) s.renOld = line.slice(12).trim();
        continue;
      }
      if (line.startsWith('rename to ')) {
        if (s.renNew === undefined) s.renNew = line.slice(10).trim();
        continue;
      }
      if (line === 'new file mode' || line.startsWith('new file mode ')) {
        s.newFile = true;
        continue;
      }
      if (line === 'deleted file mode' || line.startsWith('deleted file mode ')) {
        s.delFile = true;
        continue;
      }
    }
    // Any other line outside a body is ignored (prose, code fences, index lines).
  }
  flushHunk();
  return sections;
}

/** Apply one hunk of a change/move section to the file's lines. */
function applyUnifiedHunk(lines: string[], final: boolean, h: Hunk, d: number, strict: boolean, path: string): { lines: string[]; final: boolean } {
  const oTexts = h.o.map((x) => x.text);
  if (oTexts.length === 0) {
    const p = Math.min(Math.max(h.a + d, 0), lines.length);
    const nTexts = h.n.map((x) => x.text);
    const out = [...lines.slice(0, p), ...nTexts, ...lines.slice(p)];
    return { lines: out, final: p === lines.length ? !h.noEol : final };
  }
  const found = findTier(lines, oTexts, 0, strict);
  if (found === null) throw new Fail('no-match', path);
  const target = h.a - 1 + d;
  let best = found.occ[0]!;
  for (const pos of found.occ) {
    if (Math.abs(pos - target) < Math.abs(best - target)) best = pos;
  }
  const rep = buildReplacement(lines, h.o, h.n, best, found.tier);
  const out = [...lines.slice(0, best), ...rep, ...lines.slice(best + oTexts.length)];
  return { lines: out, final: best + oTexts.length === lines.length ? !h.noEol : final };
}

function unifiedEdit(sec: UniSection, strict: boolean): Edit {
  return (tree) => {
    const oldPath = sec.pairOld !== undefined ? sec.pairOld : sec.renOld !== undefined ? sec.renOld : sec.diffOld;
    const newPath = sec.pairNew !== undefined ? sec.pairNew : sec.renNew !== undefined ? sec.renNew : sec.diffNew;
    const create = oldPath === null || sec.newFile;
    const del = !create && (newPath === null || sec.delFile);
    if (create) {
      if (newPath === undefined || newPath === null) return;
      if (!safe(newPath)) throw new Fail('unsafe', newPath);
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const plus: string[] = [];
      for (const h of sec.hunks) for (const x of h.n) if (!x.ctx) plus.push(x.text);
      let noEol = false;
      for (let k = sec.hunks.length - 1; k >= 0; k--) {
        if (sec.hunks[k]!.n.some((x) => !x.ctx)) {
          noEol = sec.hunks[k]!.plusNoEol;
          break;
        }
      }
      tree.now.set(newPath, plus.length === 0 ? '' : plus.join('\n') + (noEol ? '' : '\n'));
      return;
    }
    if (del) {
      if (oldPath === undefined || oldPath === null) return;
      if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
      if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
      tree.now.set(oldPath, null);
      return;
    }
    if (oldPath === undefined || oldPath === null || newPath === undefined || newPath === null) return;
    const isMove = oldPath !== newPath;
    if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
    if (isMove && !safe(newPath)) throw new Fail('unsafe', newPath);
    const before = tree.get(oldPath);
    if (before === null) throw new Fail('missing', oldPath);
    if (isMove && tree.get(newPath) !== null) throw new Fail('exists', newPath);
    const parts = splitFile(before);
    let lines = parts.lines;
    let final = parts.final;
    let d = 0;
    for (const h of sec.hunks) {
      const res = applyUnifiedHunk(lines, final, h, d, strict, oldPath);
      lines = res.lines;
      final = res.final;
      d += h.n.length - h.o.length;
    }
    const text = joinFile(lines, parts.br, final);
    if (isMove) {
      tree.now.set(oldPath, null);
      tree.now.set(newPath, text);
      return { move: [oldPath, newPath] };
    }
    tree.now.set(oldPath, text);
  };
}

// ---------------------------------------------------------------------------
// Section 7: SEARCH/REPLACE blocks.
// ---------------------------------------------------------------------------

interface SrBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function parseSearchReplace(lines: string[]): SrBlock[] {
  const blocks: SrBlock[] = [];
  let prevPath: string | null = null;
  let prevEnd = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') continue;
    let path: string | null = null;
    for (let j = i - 1; j > prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${i + 1}`);
      path = prevPath;
    }
    let sep = -1;
    for (let j = i + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        sep = j;
        break;
      }
      if (t === '>>>>>>> REPLACE' || t === '<<<<<<< SEARCH') break;
    }
    if (sep === -1) throw new Exit2(`error: parse ${i + 1}`);
    let end = -1;
    for (let j = sep + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '>>>>>>> REPLACE') {
        end = j;
        break;
      }
      if (t === '<<<<<<< SEARCH') break;
    }
    if (end === -1) throw new Exit2(`error: parse ${i + 1}`);
    blocks.push({ path, oldLines: lines.slice(i + 1, sep), newLines: lines.slice(sep + 1, end) });
    prevPath = path;
    prevEnd = end;
    i = end;
  }
  if (blocks.length === 0) throw new Exit2('error: parse 1');
  return blocks;
}

function srEdit(b: SrBlock, strict: boolean): Edit {
  return (tree) => {
    if (!safe(b.path)) throw new Fail('unsafe', b.path);
    if (b.oldLines.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.now.set(b.path, b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n');
      return;
    }
    const text = tree.get(b.path);
    if (text === null) throw new Fail('missing', b.path);
    const parts = splitFile(text);
    const found = findTier(parts.lines, b.oldLines, 0, strict);
    if (found === null) throw new Fail('no-match', b.path);
    if (found.occ.length > 1) throw new Fail('ambiguous', b.path);
    const at = found.occ[0]!;
    const o: OLine[] = b.oldLines.map((t) => ({ text: t, ctx: false }));
    const n: OLine[] = b.newLines.map((t) => ({ text: t, ctx: false }));
    const rep = buildReplacement(parts.lines, o, n, at, found.tier);
    const out = [...parts.lines.slice(0, at), ...rep, ...parts.lines.slice(at + b.oldLines.length)];
    tree.now.set(b.path, joinFile(out, parts.br, parts.final));
  };
}

// ---------------------------------------------------------------------------
// Section 8: V4A patches.
// ---------------------------------------------------------------------------

interface V4aChunk {
  anchor: string | null;
  body: string[];
  eof: boolean;
  o: OLine[];
  n: OLine[];
}

interface V4aSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  lines: string[];
  chunks: V4aChunk[];
  lineNo: number;
}

function finishV4aChunk(c: V4aChunk): V4aChunk {
  const o: OLine[] = [];
  const n: OLine[] = [];
  for (const l of c.body) {
    if (l[0] === ' ') {
      o.push({ text: l.slice(1), ctx: true });
      n.push({ text: l.slice(1), ctx: true });
    } else if (l[0] === '-') {
      o.push({ text: l.slice(1), ctx: false });
    } else if (l[0] === '+') {
      n.push({ text: l.slice(1), ctx: false });
    } else if (l === '') {
      o.push({ text: '', ctx: true });
      n.push({ text: '', ctx: true });
    }
  }
  c.o = o;
  c.n = n;
  return c;
}

function parseUpdateSection(sec: V4aSection, raw: string[], startLine: number): void {
  let k = 0;
  if (raw.length > 0 && raw[0]!.startsWith('*** Move to: ')) {
    sec.moveTo = raw[0]!.slice(13).trim();
    k = 1;
  }
  let cur: V4aChunk | null = null;
  let firstChunk = true;
  const push = (): void => {
    if (cur !== null) {
      sec.chunks.push(finishV4aChunk(cur));
      cur = null;
    }
  };
  for (; k < raw.length; k++) {
    const l = raw[k]!;
    const ln = startLine + k;
    if (l.startsWith('@@')) {
      push();
      cur = { anchor: l.slice(2).trim(), body: [], eof: false, o: [], n: [] };
      firstChunk = false;
      continue;
    }
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
      if (cur === null) {
        if (!firstChunk) throw new Exit2(`error: parse ${ln}`);
        cur = { anchor: null, body: [], eof: false, o: [], n: [] };
      }
      cur.body.push(l);
      continue;
    }
    if (l.trim() === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${ln}`);
      cur.eof = true;
      push();
      firstChunk = false;
      continue;
    }
    throw new Exit2(`error: parse ${ln}`);
  }
  push();
  if (sec.chunks.length === 0 && sec.moveTo === null) throw new Exit2(`error: parse ${sec.lineNo}`);
}

function parseV4a(lines: string[]): V4aSection[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: V4aSection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    const m = /^\*\*\* (Add File|Delete File|Update File): (.*)$/.exec(line);
    if (m === null) throw new Exit2(`error: parse ${i + 1}`);
    const kind = m[1] === 'Add File' ? 'add' : m[1] === 'Delete File' ? 'delete' : 'update';
    const path = m[2]!.trim();
    let j = i + 1;
    while (j < last) {
      if (/^\*\*\* (Add File|Delete File|Update File): /.test(lines[j]!)) break;
      j++;
    }
    const raw = lines.slice(i + 1, j);
    while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
    const sec: V4aSection = { kind, path, moveTo: null, lines: [], chunks: [], lineNo: i + 1 };
    if (kind === 'add') {
      for (let k = 0; k < raw.length; k++) {
        const l = raw[k]!;
        if (l.startsWith('+')) sec.lines.push(l.slice(1));
        else if (l === '') sec.lines.push('');
        else throw new Exit2(`error: parse ${i + 2 + k}`);
      }
    } else if (kind === 'delete') {
      for (let k = 0; k < raw.length; k++) {
        if (!blank(raw[k]!)) throw new Exit2(`error: parse ${i + 2 + k}`);
      }
    } else {
      parseUpdateSection(sec, raw, i + 2);
    }
    sections.push(sec);
    i = j;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections;
}

function findAnchor(lines: string[], anchor: string, from: number, strict: boolean): number | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let i = from; i < lines.length; i++) {
      if (lineEq(lines[i]!, anchor, t)) return i;
    }
  }
  return null;
}

function v4aEdit(sec: V4aSection, strict: boolean): Edit {
  return (tree) => {
    if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
    if (sec.kind === 'add') {
      if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
      tree.now.set(sec.path, sec.lines.length === 0 ? '' : sec.lines.join('\n') + '\n');
      return;
    }
    if (sec.kind === 'delete') {
      if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
      tree.now.set(sec.path, null);
      return;
    }
    if (sec.moveTo !== null && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
    const before = tree.get(sec.path);
    if (before === null) throw new Fail('missing', sec.path);
    if (sec.moveTo !== null && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    const parts = splitFile(before);
    let lines = parts.lines;
    let cursor = 0;
    for (const ch of sec.chunks) {
      if (ch.anchor !== null) {
        const ai = findAnchor(lines, ch.anchor, cursor, strict);
        if (ai === null) throw new Fail('no-match', sec.path);
        cursor = ai + 1;
      }
      const oTexts = ch.o.map((x) => x.text);
      if (oTexts.length === 0) {
        const p = ch.eof ? lines.length : cursor;
        const nTexts = ch.n.map((x) => x.text);
        lines = [...lines.slice(0, p), ...nTexts, ...lines.slice(p)];
        cursor = p + nTexts.length;
        continue;
      }
      const tiers = strict ? [0] : [0, 1, 2];
      let found: { i: number; tier: number } | null = null;
      for (const t of tiers) {
        const occ = occurrences(lines, oTexts, t, cursor).filter((pos) => !ch.eof || pos + oTexts.length === lines.length);
        if (occ.length > 0) {
          found = { i: occ[0]!, tier: t };
          break;
        }
      }
      if (found === null) throw new Fail('no-match', sec.path);
      const rep = buildReplacement(lines, ch.o, ch.n, found.i, found.tier);
      lines = [...lines.slice(0, found.i), ...rep, ...lines.slice(found.i + oTexts.length)];
      cursor = found.i + rep.length;
    }
    const text = joinFile(lines, parts.br, parts.final);
    if (sec.moveTo !== null) {
      tree.now.set(sec.path, null);
      tree.now.set(sec.moveTo, text);
      return { move: [sec.path, sec.moveTo] };
    }
    tree.now.set(sec.path, text);
  };
}

// ---------------------------------------------------------------------------
// Sections 1, 2 and 10: the command line, output, exit codes, atomicity.
// ---------------------------------------------------------------------------

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? parseUnified(lines).map((s) => unifiedEdit(s, strict))
          : kind === 'search-replace'
            ? parseSearchReplace(lines).map((b) => srEdit(b, strict))
            : parseV4a(lines).map((s) => v4aEdit(s, strict));
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  const moves: [string, string][] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      const r = edit(tree);
      if (r !== undefined && r.move !== undefined) moves.push(r.move);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: { key: string; line: string }[] = [];
  const covered = new Set<string>();
  for (const [from, to] of moves) {
    if (tree.original(from) !== null && tree.get(from) === null && tree.original(to) === null && tree.get(to) !== null) {
      rows.push({ key: to, line: `R ${from} -> ${to}` });
      covered.add(from);
      covered.add(to);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (covered.has(p)) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
