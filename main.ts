// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

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
  /** Successful moves, in patch order, as (old path, new path) pairs. */
  readonly moves: Array<[string, string]> = [];
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

type Edit = (tree: Tree) => void;

/** One line of a hunk or chunk body: ' ' context, '-' old, '+' new, '\' a backslash line. */
interface BodyItem {
  kind: ' ' | '-' | '+' | '\\';
  text: string;
  /** True when the patch line itself was empty (a context line with empty text). */
  empty: boolean;
}

// ---- SPEC.md section 5: matching lines at three tiers ----

function leadWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return a.replace(/[ \t]+$/, '') === b.replace(/[ \t]+$/, '');
  return a.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '') === b.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Every 0-based position at which O occurs in f at or after `from`, at one tier. */
function occurrences(o: string[], f: string[], from: number, tier: number): number[] {
  const out: number[] = [];
  if (o.length === 0 || o.length > f.length - from) return out;
  for (let i = from; i + o.length <= f.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (!lineEq(o[j]!, f[i + j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

interface Found {
  tier: number;
  positions: number[];
}

/** The first tier at which O occurs in f at or after `from`, with every occurrence there. */
function findTier(o: string[], f: string[], from: number, tiers: number[]): Found | null {
  for (const t of tiers) {
    const positions = occurrences(o, f, from, t);
    if (positions.length > 0) return { tier: t, positions };
  }
  return null;
}

// ---- SPEC.md section 3: a file as lines, its line break, and its final break ----

interface FileModel {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileModel {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const fin = text.endsWith(br);
  if (fin) lines.pop();
  return { lines, br, final: fin };
}

function joinFile(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.final ? m.br : '');
}

/** Split a hunk or chunk body into its old lines O, its new lines N, and, for each line of N that is a context
 * line, the index of that line in O (context lines are written as the file's own matched line). */
function splitBody(body: BodyItem[]): { o: string[]; n: string[]; ctx: Map<number, number> } {
  const o: string[] = [];
  const n: string[] = [];
  const ctx = new Map<number, number>();
  for (const b of body) {
    if (b.kind === ' ') {
      ctx.set(n.length, o.length);
      o.push(b.text);
      n.push(b.text);
    } else if (b.kind === '-') {
      o.push(b.text);
    } else if (b.kind === '+') {
      n.push(b.text);
    }
  }
  return { o, n, ctx };
}

/** Build N for a replacement at pos: context lines from the file, every other line re-indented at tier 2. */
function buildReplacement(m: FileModel, pos: number, o: string[], n: string[], ctx: Map<number, number>, tier: number): string[] {
  const F = leadWs(m.lines[pos] ?? '');
  const P = leadWs(o[0] ?? '');
  return n.map((line, ni) => {
    if (ctx.has(ni)) return m.lines[pos + ctx.get(ni)!]!;
    if (tier === 2 && line !== '' && !/^[ \t]+$/.test(line) && line.startsWith(P)) return F + line.slice(P.length);
    return line;
  });
}

/** True when a `\` line follows the hunk's last context or `+` line. */
function backslashAfterLastCtxOrPlus(body: BodyItem[]): boolean {
  for (let k = body.length - 1; k >= 0; k--) {
    if (body[k]!.kind === ' ' || body[k]!.kind === '+') {
      return body[k + 1] !== undefined && body[k + 1]!.kind === '\\';
    }
  }
  return false;
}

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

// ---- SPEC.md section 6: unified diffs ----

interface UnifiedHunk {
  a: number;
  body: BodyItem[];
}

interface UnifiedSection {
  pairOld: string | null;
  pairNew: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  diffOld: string | null;
  diffNew: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: UnifiedHunk[];
}

/** The path named by a `--- ` or `+++ ` line: text after the four characters, to the first tab, trimmed,
 * with one leading `a/` or `b/` removed. */
function parseUnifiedPath(s: string): string {
  const t = s.split('\t')[0]!.trim();
  return t.replace(/^[ab]\//, '');
}

/** Apply a section's hunks to a file model, in order, keeping the running offset d. */
function applyHunks(model: FileModel, hunks: UnifiedHunk[], tiers: number[], path: string): void {
  let d = 0;
  for (const hunk of hunks) {
    const { o, n, ctx } = splitBody(hunk.body);
    const backslash = backslashAfterLastCtxOrPlus(hunk.body);
    if (o.length === 0) {
      const at = Math.min(hunk.a + d, model.lines.length);
      const atEnd = hunk.a + d >= model.lines.length;
      model.lines.splice(at, 0, ...n);
      if (atEnd) model.final = !backslash;
      d += n.length;
      continue;
    }
    const found = findTier(o, model.lines, 0, tiers);
    if (found === null) throw new Fail('no-match', path);
    const target = hunk.a - 1 + d;
    let pos = found.positions[0]!;
    for (const p of found.positions) {
      if (Math.abs(p - target) < Math.abs(pos - target)) pos = p;
    }
    const toEnd = pos + o.length === model.lines.length;
    const rep = buildReplacement(model, pos, o, n, ctx, found.tier);
    model.lines.splice(pos, o.length, ...rep);
    if (toEnd) model.final = !backslash;
    d += n.length - o.length;
  }
}

/** Whether a created file ends with a line break: it does unless a `\` line follows its last `+` line. */
function creationEndsWithBreak(hunks: UnifiedHunk[]): boolean {
  for (let h = hunks.length - 1; h >= 0; h--) {
    const body = hunks[h]!.body;
    for (let k = body.length - 1; k >= 0; k--) {
      if (body[k]!.kind === '+') {
        return !(body[k + 1] !== undefined && body[k + 1]!.kind === '\\');
      }
    }
  }
  return true;
}

function unifiedEdit(sec: UnifiedSection, tiers: number[]): Edit {
  const oldPath = sec.pairOld ?? sec.renameFrom ?? sec.diffOld;
  const newPath = sec.pairNew ?? sec.renameTo ?? sec.diffNew;
  const isCreate = sec.isCreate || oldPath === '/dev/null';
  const isDelete = sec.isDelete || newPath === '/dev/null';
  if (isCreate) {
    const path = newPath!;
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) !== null) throw new Fail('exists', path);
      const plus: string[] = [];
      for (const h of sec.hunks) for (const b of h.body) if (b.kind === '+') plus.push(b.text);
      tree.now.set(path, plus.length === 0 ? '' : plus.join('\n') + (creationEndsWithBreak(sec.hunks) ? '\n' : ''));
    };
  }
  if (isDelete) {
    const path = oldPath!;
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) === null) throw new Fail('missing', path);
      tree.now.set(path, null);
    };
  }
  if (oldPath !== newPath) {
    const from = oldPath!;
    const to = newPath!;
    return (tree) => {
      if (!safe(from)) throw new Fail('unsafe', from);
      if (!safe(to)) throw new Fail('unsafe', to);
      const before = tree.get(from);
      if (before === null) throw new Fail('missing', from);
      if (tree.get(to) !== null) throw new Fail('exists', to);
      const model = splitFile(before);
      applyHunks(model, sec.hunks, tiers, from);
      tree.now.set(from, null);
      tree.now.set(to, joinFile(model));
      tree.moves.push([from, to]);
    };
  }
  const path = oldPath!;
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const model = splitFile(before);
    applyHunks(model, sec.hunks, tiers, path);
    tree.now.set(path, joinFile(model));
  };
}

function unifiedEdits(lines: string[], tiers: number[]): Edit[] {
  const sections: UnifiedSection[] = [];
  let cur: UnifiedSection | null = null;
  let inHeader = false;
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)\s*$/.exec(l);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      cur = {
        pairOld: null, pairNew: null, renameFrom: null, renameTo: null,
        diffOld: m[1]!, diffNew: m[2]!, isCreate: false, isDelete: false, hunks: [],
      };
      sections.push(cur);
      inHeader = true;
      i++;
      continue;
    }
    if (l.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(l);
      if (!m || cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const hunk: UnifiedHunk = { a: Number(m[1]), body: [] };
      cur.hunks.push(hunk);
      inHeader = false;
      i++;
      while (i < lines.length) {
        const b = lines[i]!;
        // The body ends at a `--- ` line followed by a `+++ ` line: a new section starts there.
        if (b.startsWith('--- ') && lines[i + 1] !== undefined && lines[i + 1]!.startsWith('+++ ')) break;
        if (b === '' || b.startsWith(' ') || b.startsWith('-') || b.startsWith('+') || b.startsWith('\\')) {
          hunk.body.push({
            kind: b === '' ? ' ' : (b[0] as ' ' | '-' | '+' | '\\'),
            text: b === '' ? '' : b.slice(1),
            empty: b === '',
          });
          i++;
        } else {
          break;
        }
      }
      // Empty lines at the end of a body are not part of it: an empty line is a context line whose text is empty.
      while (hunk.body.length > 0) {
        const last = hunk.body[hunk.body.length - 1]!;
        if (last.kind === ' ' && last.text === '') hunk.body.pop();
        else break;
      }
      continue;
    }
    if (l.startsWith('--- ')) {
      const next = lines[i + 1];
      if (next !== undefined && next.startsWith('+++ ')) {
        if (cur !== null && inHeader && cur.pairOld === null) {
          cur.pairOld = parseUnifiedPath(l.slice(4));
          cur.pairNew = parseUnifiedPath(next.slice(4));
          i += 2;
          continue;
        }
        cur = {
          pairOld: parseUnifiedPath(l.slice(4)), pairNew: parseUnifiedPath(next.slice(4)),
          renameFrom: null, renameTo: null, diffOld: null, diffNew: null,
          isCreate: false, isDelete: false, hunks: [],
        };
        sections.push(cur);
        inHeader = true;
        i += 2;
        continue;
      }
      if (cur !== null && inHeader) throw new Exit2(`error: parse ${i + 2}`);
      i++;
      continue;
    }
    if (cur !== null && inHeader) {
      if (l.startsWith('+++ ')) {
        if (cur.pairNew === null) cur.pairNew = parseUnifiedPath(l.slice(4));
      } else if (l.startsWith('rename from ')) {
        cur.renameFrom = l.slice('rename from '.length).trim();
      } else if (l.startsWith('rename to ')) {
        cur.renameTo = l.slice('rename to '.length).trim();
      } else if (l.startsWith('new file mode')) {
        cur.isCreate = true;
      } else if (l.startsWith('deleted file mode')) {
        cur.isDelete = true;
      }
    }
    i++;
  }
  return sections.map((s) => unifiedEdit(s, tiers));
}

// ---- SPEC.md section 7: SEARCH/REPLACE blocks ----

interface SrBlock {
  path: string;
  old: string[];
  nw: string[];
}

function srEdit(b: SrBlock, tiers: number[]): Edit {
  return (tree) => {
    if (!safe(b.path)) throw new Fail('unsafe', b.path);
    if (b.old.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.now.set(b.path, b.nw.length === 0 ? '' : b.nw.join('\n') + '\n');
      return;
    }
    const before = tree.get(b.path);
    if (before === null) throw new Fail('missing', b.path);
    const model = splitFile(before);
    const found = findTier(b.old, model.lines, 0, tiers);
    if (found === null) throw new Fail('no-match', b.path);
    if (found.positions.length > 1) throw new Fail('ambiguous', b.path);
    const pos = found.positions[0]!;
    const rep = buildReplacement(model, pos, b.old, b.nw, new Map(), found.tier);
    model.lines.splice(pos, b.old.length, ...rep);
    tree.now.set(b.path, joinFile(model));
  };
}

function srEdits(lines: string[], tiers: number[]): Edit[] {
  const blocks: SrBlock[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  while (true) {
    let s = -1;
    for (let j = prevEnd + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') {
        s = j;
        break;
      }
    }
    if (s < 0) break;
    let path: string | null = null;
    for (let j = s - 1; j > prevEnd; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${s + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = s + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        eq = j;
        break;
      }
      if (t === '>>>>>>> REPLACE') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${s + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${s + 1}`);
    blocks.push({ path, old: lines.slice(s + 1, eq), nw: lines.slice(eq + 1, rep) });
    prevEnd = rep;
    prevPath = path;
  }
  if (blocks.length === 0) throw new Exit2('error: parse 1');
  return blocks.map((b) => srEdit(b, tiers));
}

// ---- SPEC.md section 8: V4A patches ----

interface V4aChunk {
  anchor: string | null;
  body: BodyItem[];
  eof: boolean;
}

function v4aAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: V4aChunk[], tiers: number[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null) {
      if (!safe(moveTo)) throw new Fail('unsafe', moveTo);
      if (tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    }
    const model = splitFile(before);
    let cursor = 0;
    for (const chunk of chunks) {
      if (chunk.anchor !== null) {
        let foundLine: number | null = null;
        for (const t of tiers) {
          for (let k = cursor; k < model.lines.length; k++) {
            if (lineEq(chunk.anchor, model.lines[k]!, t)) {
              foundLine = k;
              break;
            }
          }
          if (foundLine !== null) break;
        }
        if (foundLine === null) throw new Fail('no-match', path);
        cursor = foundLine + 1;
      }
      const { o, n, ctx } = splitBody(chunk.body);
      if (o.length === 0) {
        const at = chunk.eof ? model.lines.length : cursor;
        model.lines.splice(at, 0, ...n);
        cursor = at + n.length;
        continue;
      }
      let found: Found | null = null;
      let pos: number | undefined;
      for (const t of tiers) {
        const positions = occurrences(o, model.lines, cursor, t);
        const ok = chunk.eof ? positions.filter((p) => p + o.length === model.lines.length) : positions;
        if (ok.length > 0) {
          found = { tier: t, positions: ok };
          pos = ok[0]!;
          break;
        }
      }
      if (found === null || pos === undefined) throw new Fail('no-match', path);
      const rep = buildReplacement(model, pos, o, n, ctx, found.tier);
      model.lines.splice(pos, o.length, ...rep);
      cursor = pos + rep.length;
    }
    const text = joinFile(model);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, text);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, text);
    }
  };
}

function parseV4aChunks(span: string[], baseLine: number, updateLine: number): { moveTo: string | null; chunks: V4aChunk[] } {
  let idx = 0;
  let moveTo: string | null = null;
  if (span.length > 0 && span[0]!.startsWith('*** Move to:')) {
    moveTo = span[0]!.slice('*** Move to:'.length).trim();
    idx = 1;
  }
  const chunks: V4aChunk[] = [];
  let cur: V4aChunk | null = null;
  let started = false;
  for (; idx < span.length; idx++) {
    const l = span[idx]!;
    if (l.startsWith('@@')) {
      if (cur !== null) chunks.push(cur);
      const anchor = l.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, body: [], eof: false };
      started = true;
      continue;
    }
    if (l === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${baseLine + idx + 1}`);
      cur.eof = true;
      chunks.push(cur);
      cur = null;
      continue;
    }
    if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l === '') {
      if (cur === null) {
        if (started) throw new Exit2(`error: parse ${baseLine + idx + 1}`);
        cur = { anchor: null, body: [], eof: false };
        started = true;
      }
      cur.body.push({ kind: l === '' ? ' ' : (l[0] as ' ' | '-' | '+'), text: l === '' ? '' : l.slice(1), empty: l === '' });
      continue;
    }
    throw new Exit2(`error: parse ${baseLine + idx + 1}`);
  }
  if (cur !== null) chunks.push(cur);
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine + 1}`);
  return { moveTo, chunks };
}

function v4aEdits(lines: string[], tiers: number[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last--;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File:') || l.startsWith('*** Delete File:') || l.startsWith('*** Update File:');
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i]!)) {
      i++;
      continue;
    }
    const l = lines[i]!;
    if (!isSectionStart(l)) throw new Exit2(`error: parse ${i + 1}`);
    let j = i + 1;
    while (j < last && !isSectionStart(lines[j]!)) j++;
    // Blank lines at the end of a section (before the next section or *** End Patch) are not part of it.
    const span = lines.slice(i + 1, j);
    while (span.length > 0 && blank(span[span.length - 1]!)) span.pop();
    const baseLine = i + 1;
    if (l.startsWith('*** Add File:')) {
      const path = l.slice('*** Add File:'.length).trim();
      const fileLines: string[] = [];
      for (let k = 0; k < span.length; k++) {
        const s = span[k]!;
        if (s.startsWith('+')) fileLines.push(s.slice(1));
        else if (s === '') fileLines.push('');
        else throw new Exit2(`error: parse ${baseLine + k + 1}`);
      }
      edits.push(v4aAddEdit(path, fileLines));
    } else if (l.startsWith('*** Delete File:')) {
      const path = l.slice('*** Delete File:'.length).trim();
      if (span.length > 0) throw new Exit2(`error: parse ${baseLine + 1}`);
      edits.push(v4aDeleteEdit(path));
    } else {
      const path = l.slice('*** Update File:'.length).trim();
      const { moveTo, chunks } = parseV4aChunks(span, baseLine, i);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, tiers));
    }
    i = j;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

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
    const tiers = strict ? [0] : [0, 1, 2];
    edits =
      kind === 'json' ? jsonEdits(text, lines)
      : kind === 'unified' ? unifiedEdits(lines, tiers)
      : kind === 'search-replace' ? srEdits(lines, tiers)
      : v4aEdits(lines, tiers);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // One row per changed path, sorted by path in byte order; a move prints as one `R <old> -> <new>` row,
  // sorted by the new path, instead of a `D` row for the old path plus an `A` row for the new one.
  const rows: Array<{ key: string; line: string }> = [];
  const movedOld = new Set<string>();
  const movedNew = new Set<string>();
  for (const [from, to] of tree.moves) {
    if (tree.original(from) !== null && tree.original(to) === null && tree.get(from) === null && tree.get(to) !== null) {
      rows.push({ key: to, line: `R ${from} -> ${to}` });
      movedOld.add(from);
      movedNew.add(to);
    }
  }
  for (const p of tree.now.keys()) {
    if (movedOld.has(p) || movedNew.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of tree.now.keys()) {
      const now = tree.now.get(p)!;
      if (tree.original(p) === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const outRows = rows.map((r) => r.line);
  return { code: 0, out: [...outRows, `ok: ${outRows.length} ${outRows.length === 1 ? 'file' : 'files'}`] };
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
