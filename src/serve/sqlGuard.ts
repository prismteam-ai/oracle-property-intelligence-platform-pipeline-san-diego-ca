export const MAX_QUERY_ROWS = 1000;

export class QueryRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QueryRejectedError';
  }
}

const FORBIDDEN =
  /\b(insert|update|delete|drop|create|alter|attach|detach|copy|export|import|install|load|pragma|set|reset|call|vacuum|checkpoint|truncate|grant|revoke|begin|commit|rollback|use|describe|summarize|explain)\b/i;

/** Table functions that read files or the network. The store also disables external access. */
const FORBIDDEN_FUNCTIONS =
  /\b(read_[a-z_]+|parquet_[a-z_]+|glob|sniff_csv|duckdb_[a-z_]+|getenv|query|query_table|iceberg_[a-z_]+|delta_[a-z_]+|postgres_[a-z_]+|sqlite_[a-z_]+|http_[a-z_]+)\s*\(/i;

function stripLiteralsAndComments(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""');
}

/**
 * Gate for agent-written SQL: exactly one read-only SELECT (or WITH ... SELECT), no file or
 * network functions, and a hard row cap applied from outside so the model cannot remove it.
 * Returns the statement that will actually run.
 */
export function guardSelect(input: string, maxRows = MAX_QUERY_ROWS): string {
  const trimmed = input.trim().replace(/;\s*$/, '');
  if (trimmed.length === 0) throw new QueryRejectedError('Empty query.');
  if (trimmed.length > 4000) throw new QueryRejectedError('Query longer than 4000 characters.');
  const bare = stripLiteralsAndComments(trimmed);
  if (bare.includes(';')) throw new QueryRejectedError('Only one statement is allowed.');
  if (!/^\s*(select|with)\b/i.test(bare)) {
    throw new QueryRejectedError('Only SELECT (or WITH ... SELECT) is allowed.');
  }
  const keyword = FORBIDDEN.exec(bare);
  if (keyword) throw new QueryRejectedError(`Keyword not allowed in a read-only query: ${keyword[0]}`);
  const fn = FORBIDDEN_FUNCTIONS.exec(bare);
  if (fn) throw new QueryRejectedError(`Function not allowed: ${fn[0].replace(/\s*\($/, '')}`);
  return `SELECT * FROM (${trimmed}) AS q LIMIT ${maxRows + 1}`;
}
