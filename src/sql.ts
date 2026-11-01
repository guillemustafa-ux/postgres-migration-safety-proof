/**
 * Split a migration file into top-level statements.
 * Understands `--` and block comments, single-quoted strings, quoted identifiers and dollar
 * quoting (`$$ ... $$`, `$tag$ ... $tag$`), which is enough for plain SQL migrations.
 */
export function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let start = 0;
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (ch === '-' && next === '-') {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? sql.length : end + 1;
    } else if (ch === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 2;
    } else if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === ch && sql[j + 1] === ch) j += 2;
        else if (sql[j] === ch) break;
        else j++;
      }
      i = j + 1;
    } else if (ch === '$') {
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (tag) {
        const end = sql.indexOf(tag[0], i + tag[0].length);
        i = end === -1 ? sql.length : end + tag[0].length;
      } else {
        i++;
      }
    } else if (ch === ';') {
      push(sql.slice(start, i));
      start = i + 1;
      i++;
    } else {
      i++;
    }
  }
  push(sql.slice(start));
  return out;

  function push(chunk: string) {
    if (stripComments(chunk).trim()) out.push(chunk.trim());
  }
}

export function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

/** One-line label for a statement: comments removed, whitespace collapsed, truncated. */
export function label(statement: string, max = 90): string {
  const flat = stripComments(statement).replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
}

/** Statements that Postgres refuses to run inside a transaction block. */
export function needsAutocommit(statement: string): boolean {
  return /\bconcurrently\b/i.test(stripComments(statement));
}
