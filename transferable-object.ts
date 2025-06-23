// @ts-check
/// <reference lib="esnext" />
/// <reference types="@cloudflare/workers-types" />

import { DurableObject } from "cloudflare:workers";

// Configuration interfaces
export interface ExportConfig {
  includeSchema?: boolean;
  includeData?: boolean;
  tableWhitelist?: string[];
  tableBlacklist?: string[];
}

export interface DumpConfig {
  r2BucketBindingName: string;
  key: string;
  exportConfig?: ExportConfig;
}

export interface ImportResult {
  success: boolean;
  executedStatements: number;
  errors?: string[];
  tablesCreated?: string[];
  rowsInserted?: number;
  warnings?: string[];
}

export interface TransferableConfig {
  secret?: string;
  isReadonlyPublic?: boolean;
}

export interface CloneConfig {
  clearOnImport?: boolean;
  clearAfterExport?: boolean;
  exportBasicAuth?: string;
  importBasicAuth?: string;
}

// Safe query execution result
interface QueryResult {
  success: boolean;
  error?: string;
  warning?: string;
  tableCreated?: string;
  rowsAffected?: number;
  query?: string;
}

// Utility function for cloning between DO instances
export async function clone(
  exportUrl: string,
  importUrl: string,
  config: CloneConfig = {},
): Promise<{
  success: boolean;
  exportResult?: any;
  importResult?: ImportResult;
  clearResults?: any;
  error?: string;
}> {
  try {
    const {
      clearOnImport = false,
      clearAfterExport = false,
      exportBasicAuth,
      importBasicAuth,
    } = config;

    // Clear destination if requested
    if (clearOnImport) {
      const clearHeaders: HeadersInit = { "Content-Type": "application/json" };
      if (importBasicAuth) {
        clearHeaders["Authorization"] = `Basic ${btoa(importBasicAuth)}`;
      }

      const clearResponse = await fetch(`${importUrl}/transfer/clear`, {
        method: "POST",
        headers: clearHeaders,
      });

      if (!clearResponse.ok) {
        throw new Error(`Clear import failed: ${clearResponse.statusText}`);
      }
    }

    // Export from source
    const exportHeaders: HeadersInit = {};
    if (exportBasicAuth) {
      exportHeaders["Authorization"] = `Basic ${btoa(exportBasicAuth)}`;
    }

    const exportResponse = await fetch(`${exportUrl}/transfer/export`, {
      headers: exportHeaders,
    });

    if (!exportResponse.ok) {
      throw new Error(`Export failed: ${exportResponse.statusText}`);
    }

    // Import to destination
    const importHeaders: HeadersInit = { "Content-Type": "application/sql" };
    if (importBasicAuth) {
      importHeaders["Authorization"] = `Basic ${btoa(importBasicAuth)}`;
    }

    const importResponse = await fetch(`${importUrl}/transfer/import`, {
      method: "POST",
      headers: importHeaders,
      body: exportResponse.body,
    });

    if (!importResponse.ok) {
      throw new Error(`Import failed: ${importResponse.statusText}`);
    }

    const importResult: ImportResult = await importResponse.json();

    // Clear source if requested
    let clearAfterResult;
    if (clearAfterExport) {
      const clearHeaders: HeadersInit = { "Content-Type": "application/json" };
      if (exportBasicAuth) {
        clearHeaders["Authorization"] = `Basic ${btoa(exportBasicAuth)}`;
      }

      const clearResponse = await fetch(`${exportUrl}/transfer/clear`, {
        method: "POST",
        headers: clearHeaders,
      });

      if (!clearResponse.ok) {
        console.warn(`Clear after export failed: ${clearResponse.statusText}`);
      } else {
        clearAfterResult = await clearResponse.json();
      }
    }

    return {
      success: importResult.success,
      importResult,
      clearResults: clearAfterResult,
    };
  } catch (error) {
    return {
      success: false,
      error: `Clone operation failed: ${String(error)}`,
    };
  }
}

// Transfer class that provides all functionality
export class Transfer {
  storage: DurableObjectStorage;
  private config: TransferableConfig;

  constructor(
    private durableObject: DurableObject,
    config: TransferableConfig = {},
  ) {
    //@ts-ignore (it works idk why complain)
    this.storage = durableObject.ctx.storage;
    this.config = config;
  }

  // Authentication helper
  checkAuth(request: Request, requireAuth: boolean = true): boolean {
    if (!this.config.secret) return true; // No auth configured
    if (!requireAuth && this.config.isReadonlyPublic) return true; // Readonly public access

    const authHeader = request.headers.get("Authorization");
    let credentials = undefined;
    if (authHeader && authHeader.startsWith("Basic")) {
      try {
        credentials = atob(authHeader.slice(6));
      } catch {}
    }

    const apiKeyQueryParam = new URL(request.url).searchParams.get("apiKey");
    if (credentials === this.config.secret) {
      return true;
    }
    if (apiKeyQueryParam === this.config.secret) {
      return true;
    }
    return false;
  }

  unauthorizedResponse(): Response {
    return new Response("Unauthorized", {
      status: 401,
      headers: {
        "WWW-Authenticate": 'Basic realm="Transferable DO"',
        "Content-Type": "text/plain",
      },
    });
  }

  // Safe query execution with detailed error reporting
  private safeExec(query: string, ...params: any[]): QueryResult {
    try {
      const result = this.storage.sql.exec(query, ...params);
      return {
        success: true,
        rowsAffected: result.rowsWritten || 0,
        query: query.substring(0, 100) + (query.length > 100 ? "..." : ""),
      };
    } catch (error) {
      const errorMsg = `Query failed: "${query.substring(0, 100)}${
        query.length > 100 ? "..." : ""
      }" - Error: ${String(error)}`;
      console.error(errorMsg);

      if (String(error).includes("SQLITE_AUTH")) {
        return {
          success: false,
          error: `SQLITE_AUTH: Operation not permitted - ${errorMsg}`,
          query: query,
        };
      }

      return {
        success: false,
        error: errorMsg,
        query: query,
      };
    }
  }

  // Safe query for data retrieval
  private safeQuery(
    query: string,
    ...params: any[]
  ): { success: boolean; data?: any[]; error?: string; query?: string } {
    try {
      const result = this.storage.sql.exec(query, ...params);
      return {
        success: true,
        data: result.toArray(),
        query: query.substring(0, 100) + (query.length > 100 ? "..." : ""),
      };
    } catch (error) {
      const errorMsg = `Query failed: "${query.substring(0, 100)}${
        query.length > 100 ? "..." : ""
      }" - Error: ${String(error)}`;
      console.error(errorMsg);
      return {
        success: false,
        error: errorMsg,
        query: query,
      };
    }
  }

  // Get table list safely
  private getTableList(): string[] {
    const result = this.safeQuery(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'`,
    );
    if (!result.success || !result.data) {
      console.warn("Could not retrieve table list, using empty list");
      return [];
    }
    return result.data.map((row: any) => row.name as string);
  }

  // Get table schema safely
  private getTableSchema(tableName: string): string | null {
    const result = this.safeQuery(
      `SELECT sql FROM sqlite_master WHERE type='table' AND name = ?`,
      tableName,
    );
    if (!result.success || !result.data || result.data.length === 0) {
      console.warn(`Could not retrieve schema for table: ${tableName}`);
      return null;
    }
    return result.data[0].sql as string;
  }

  // Get table columns safely
  private getTableColumns(tableName: string): string[] {
    const result = this.safeQuery(`PRAGMA table_info(${tableName})`);
    if (!result.success || !result.data) {
      console.warn(
        `Could not retrieve columns for table: ${tableName}, using SELECT * approach`,
      );
      // Fallback: try to get one row and extract column names
      const sampleResult = this.safeQuery(`SELECT * FROM ${tableName} LIMIT 1`);
      if (
        sampleResult.success &&
        sampleResult.data &&
        sampleResult.data.length > 0
      ) {
        return Object.keys(sampleResult.data[0]);
      }
      return [];
    }
    return result.data.map((col: any) => col.name as string);
  }

  // Clear all data from the DO instance
  async clear(): Promise<{
    success: boolean;
  }> {
    const alarm = await this.storage.getAlarm();
    if (alarm) {
      await this.storage.deleteAlarm();
    }
    await this.storage.deleteAll({});
    return { success: true };
  }

  // Import from URL that streams SQL
  async importFromUrl(url: string, auth?: string): Promise<ImportResult> {
    try {
      const headers: HeadersInit = {};
      if (auth) {
        headers["Authorization"] = `Basic ${btoa(auth)}`;
      }

      const response = await fetch(url, { headers });
      if (!response.ok) {
        throw new Error(`Failed to fetch from ${url}: ${response.statusText}`);
      }

      // Create a new request with the response body
      const importRequest = new Request("http://dummy", {
        method: "POST",
        body: response.body,
        headers: { "Content-Type": "application/sql" },
      });

      return await this.runFromFile(importRequest);
    } catch (error) {
      return {
        success: false,
        executedStatements: 0,
        errors: [`Import from URL failed: ${String(error)}`],
      };
    }
  }

  // Helper function to escape SQL values
  private escapeSQLValue(value: any): string {
    if (value === null || value === undefined) {
      return "NULL";
    }

    if (typeof value === "string") {
      // Escape single quotes by doubling them
      return `'${value.replace(/'/g, "''")}'`;
    }

    if (typeof value === "number") {
      return String(value);
    }

    if (typeof value === "boolean") {
      return value ? "1" : "0";
    }

    if (value instanceof ArrayBuffer) {
      return `X'${Array.from(new Uint8Array(value))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("")}'`;
    }

    if (value instanceof Uint8Array) {
      return `X'${Array.from(value)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("")}'`;
    }

    // For any other type, convert to string and escape
    return `'${String(value).replace(/'/g, "''")}'`;
  }

  // Export database as SQL dump with comprehensive config
  async getExport(config: ExportConfig = {}): Promise<Response> {
    const {
      includeSchema = true,
      includeData = true,
      tableWhitelist = [],
      tableBlacklist = [],
    } = config;

    const BATCH_SIZE = 10000;
    const MAX_STATEMENT_SIZE = 100 * 1024; // 100KB

    let exportedTables: string[] = [];
    let totalRows = 0;
    let warnings: string[] = [];

    const readable = new ReadableStream({
      start: (controller) => {
        try {
          const writeText = (text: string) => {
            controller.enqueue(new TextEncoder().encode(text));
          };

          const writeHeader = () => {
            writeText(
              `-- Database Export\n-- Generated: ${new Date().toISOString()}\n\n`,
            );
          };

          const writeFooter = () => {
            writeText(
              `\n-- Export completed\n-- Tables: ${exportedTables.length}\n-- Total rows: ${totalRows}\n`,
            );
            if (warnings.length > 0) {
              writeText(
                `-- Warnings:\n${warnings.map((w) => `-- ${w}`).join("\n")}\n`,
              );
            }
          };

          writeHeader();

          // Get all tables safely (excluding _cf_ tables by default)
          const allTables = this.getTableList();
          if (allTables.length === 0) {
            warnings.push("No tables found or could not access table list");
          }

          // Filter tables based on whitelist/blacklist
          const tables = allTables.filter((tableName) => {
            if (tableWhitelist.length > 0) {
              return tableWhitelist.includes(tableName);
            }
            if (tableBlacklist.length > 0) {
              return !tableBlacklist.includes(tableName);
            }
            return true;
          });

          exportedTables = tables;

          // Export schema
          if (includeSchema) {
            for (const tableName of tables) {
              writeText(`\n-- Table structure for ${tableName}\n`);

              const schemaSQL = this.getTableSchema(tableName);
              if (schemaSQL) {
                // Convert to CREATE TABLE IF NOT EXISTS for safer imports
                const safeSQL = schemaSQL.replace(
                  /CREATE TABLE\s+/i,
                  "CREATE TABLE IF NOT EXISTS ",
                );
                writeText(`${safeSQL};\n\n`);
              } else {
                warnings.push(
                  `Could not export schema for table: ${tableName}`,
                );
                writeText(
                  `-- Warning: Could not export schema for ${tableName}\n\n`,
                );
              }
            }
          }

          // Export data
          if (includeData) {
            for (const tableName of tables) {
              writeText(`\n-- Data for table ${tableName}\n`);

              try {
                // Get column info
                const columns = this.getTableColumns(tableName);
                if (columns.length === 0) {
                  warnings.push(
                    `Could not export data for table: ${tableName} - no columns found`,
                  );
                  continue;
                }

                // Stream data using cursor
                let tableRowCount = 0;
                let offset = 0;

                while (true) {
                  let currentStatementSize = 0;
                  let currentValues: string[] = [];
                  let batchRowCount = 0;

                  // Build batch until we hit size limit or batch size
                  const result = this.storage.sql.exec(
                    `SELECT * FROM ${tableName} LIMIT ? OFFSET ?`,
                    BATCH_SIZE,
                    offset,
                  );

                  // Process rows one by one
                  for (const row of result) {
                    const rowValues = columns.map((col) => {
                      return this.escapeSQLValue((row as any)[col]);
                    });

                    const valueString = `(${rowValues.join(", ")})`;
                    const valueStringSize = new TextEncoder().encode(
                      valueString,
                    ).length;

                    // Check if adding this row would exceed our statement size limit
                    if (
                      currentValues.length > 0 &&
                      currentStatementSize + valueStringSize >
                        MAX_STATEMENT_SIZE
                    ) {
                      // Write current batch
                      const insertStmt = `INSERT OR IGNORE INTO ${tableName} (${columns.join(
                        ", ",
                      )}) VALUES\n${currentValues.join(",\n")};\n`;
                      writeText(insertStmt);

                      // Reset for next batch
                      currentValues = [];
                      currentStatementSize = 0;
                    }

                    currentValues.push(valueString);
                    currentStatementSize += valueStringSize;
                    batchRowCount++;
                    tableRowCount++;
                    totalRows++;
                  }

                  // Write any remaining values
                  if (currentValues.length > 0) {
                    const insertStmt = `INSERT OR IGNORE INTO ${tableName} (${columns.join(
                      ", ",
                    )}) VALUES\n${currentValues.join(",\n")};\n`;
                    writeText(insertStmt);
                  }

                  // If we got fewer rows than requested, we're done
                  if (batchRowCount < BATCH_SIZE) {
                    break;
                  }

                  offset += BATCH_SIZE;
                }

                if (tableRowCount > 0) {
                  writeText(
                    `-- ${tableRowCount} rows exported from ${tableName}\n\n`,
                  );
                }
              } catch (error) {
                warnings.push(
                  `Failed to export data from ${tableName}: ${String(error)}`,
                );
                writeText(
                  `-- Error exporting data from ${tableName}: ${String(
                    error,
                  )}\n\n`,
                );
              }
            }
          }

          writeFooter();
          controller.close();
        } catch (error) {
          console.error("Export stream error:", error);
          controller.error(new Error(`Export failed: ${String(error)}`));
        }
      },
    });

    return new Response(readable, {
      headers: {
        "Content-Type": "application/sql",
        "Content-Disposition": 'attachment; filename="database_export.sql"',
        "X-Exported-Tables": exportedTables.join(","),
        "X-Total-Rows": totalRows.toString(),
        "X-Warnings": warnings.length.toString(),
      },
    });
  }

  // Import from SQL file (streaming)
  async runFromFile(request: Request): Promise<ImportResult> {
    if (!request.body) {
      throw new Error("No SQL file provided");
    }

    const reader = request.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let executedStatements = 0;
    let errors: string[] = [];
    let warnings: string[] = [];
    let tablesCreated: string[] = [];
    let rowsInserted = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          // Process any remaining statements in buffer
          if (buffer.trim()) {
            const statements = this.parseSQLStatements(buffer);
            for (const stmt of statements) {
              const result = this.executeStatementSafely(stmt);
              executedStatements++;
              if (result.error) {
                errors.push(result.error);
              } else {
                if (result.warning) warnings.push(result.warning);
                if (result.tableCreated)
                  tablesCreated.push(result.tableCreated);
                if (result.rowsAffected) rowsInserted += result.rowsAffected;
              }
            }
          }
          break;
        }

        buffer += decoder.decode(value, { stream: true });

        // Process complete statements
        const statements = this.parseSQLStatements(buffer);
        const lastSemicolon = buffer.lastIndexOf(";");

        if (lastSemicolon !== -1) {
          buffer = buffer.substring(lastSemicolon + 1);

          for (const stmt of statements) {
            const result = this.executeStatementSafely(stmt);
            executedStatements++;
            if (result.error) {
              errors.push(result.error);
            } else {
              if (result.warning) warnings.push(result.warning);
              if (result.tableCreated) tablesCreated.push(result.tableCreated);
              if (result.rowsAffected) rowsInserted += result.rowsAffected;
            }
          }
        }
      }

      return {
        success: errors.length === 0,
        executedStatements,
        errors: errors.length > 0 ? errors : undefined,
        warnings: warnings.length > 0 ? warnings : undefined,
        tablesCreated,
        rowsInserted,
      };
    } catch (error) {
      return {
        success: false,
        executedStatements,
        errors: [...errors, `Import stream error: ${String(error)}`],
        warnings: warnings.length > 0 ? warnings : undefined,
        tablesCreated,
        rowsInserted,
      };
    }
  }

  // Dump to R2 bucket with exact sizing using 2-pass approach
  async dump(config: DumpConfig): Promise<{
    success: boolean;
    key: string;
    size: number;
    warnings?: string[];
  }> {
    const { r2BucketBindingName, key, exportConfig = {} } = config;

    try {
      // Get the bucket
      const bucket = ((this.durableObject as any).env as any)?.[
        r2BucketBindingName
      ];
      if (!bucket) {
        throw new Error(
          `R2 bucket '${r2BucketBindingName}' not found in environment`,
        );
      }

      // Pass 1: Calculate exact size by generating the export and measuring it
      const sizeCalculationResponse = await this.getExport(exportConfig);
      const sizeCalculationReader = sizeCalculationResponse.body!.getReader();

      let exactSize = 0;
      while (true) {
        const { done, value } = await sizeCalculationReader.read();
        if (done) break;
        exactSize += value.length;
      }

      // Pass 2: Create FixedLengthStream with exact size and stream the export
      const { readable, writable } = new FixedLengthStream(exactSize);

      // Start R2 upload with the readable side
      const uploadPromise = bucket.put(key, readable, {
        httpMetadata: {
          contentType: "application/sql",
        },
        customMetadata: {
          "exported-at": new Date().toISOString(),
          "durable-object-id": (this.durableObject as any).id?.toString(),
          "export-size": exactSize.toString(),
        },
      });

      // Stream the export to the writable side
      const writer = writable.getWriter();
      const exportResponse = await this.getExport(exportConfig);
      const exportReader = exportResponse.body!.getReader();

      try {
        while (true) {
          const { done, value } = await exportReader.read();
          if (done) break;
          await writer.write(value);
        }
      } finally {
        await writer.close();
      }

      const result = await uploadPromise;
      const warnings = exportResponse.headers.get("X-Warnings");

      return {
        success: true,
        key: result.key,
        size: exactSize,
        warnings:
          warnings && parseInt(warnings) > 0
            ? ["Export completed with warnings"]
            : undefined,
      };
    } catch (error) {
      console.error("Dump error:", error);
      return {
        success: false,
        key: "",
        size: 0,
        warnings: [`Dump failed: ${String(error)}`],
      };
    }
  }

  // Helper function to parse SQL statements from text
  parseSQLStatements(text: string): string[] {
    const statements: string[] = [];
    const lines = text.split("\n");
    let currentStatement = "";

    for (const line of lines) {
      const trimmedLine = line.trim();

      // Skip comments and empty lines
      if (trimmedLine.startsWith("--") || trimmedLine === "") {
        continue;
      }

      currentStatement += line + "\n";

      // If line ends with semicolon, we have a complete statement
      if (trimmedLine.endsWith(";")) {
        const stmt = currentStatement.trim();
        if (stmt) {
          statements.push(stmt);
        }
        currentStatement = "";
      }
    }

    return statements;
  }

  private executeStatementSafely(statement: string): QueryResult {
    const trimmedStatement = statement.trim();

    // Skip known problematic statements
    if (trimmedStatement.match(/^(BEGIN|COMMIT|ROLLBACK|PRAGMA)/i)) {
      return {
        success: true,
        warning: `Skipped unsupported statement: ${trimmedStatement.substring(
          0,
          50,
        )}...`,
      };
    }

    // Skip DROP statements if they might cause issues
    if (trimmedStatement.match(/^DROP\s+TABLE/i)) {
      return {
        success: true,
        warning: `Skipped DROP TABLE statement: ${trimmedStatement.substring(
          0,
          50,
        )}...`,
      };
    }

    // Skip _cf_ table operations
    if (trimmedStatement.match(/_cf_/i)) {
      return {
        success: true,
        warning: `Skipped _cf_ table operation: ${trimmedStatement.substring(
          0,
          50,
        )}...`,
      };
    }

    const result = this.safeExec(statement);

    // Check if this created a table
    const createTableMatch = statement.match(
      /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/i,
    );
    if (createTableMatch && result.success) {
      result.tableCreated = createTableMatch[1];
    }

    return result;
  }
}

// Transfer interface for type checking
export interface TransferInterface {
  getExport(config?: ExportConfig): Promise<Response>;
  runFromFile(request: Request): Promise<ImportResult>;
  dump(config: DumpConfig): Promise<{
    success: boolean;
    key: string;
    size: number;
    warnings?: string[];
  }>;
  clear(): Promise<{
    success: boolean;
    tablesDropped: string[];
    errors?: string[];
  }>;
  importFromUrl(url: string, auth?: string): Promise<ImportResult>;
}

// Decorator function that adds transferable functionality
export function Transferable<T extends new (...args: any[]) => DurableObject>(
  config: TransferableConfig = {},
) {
  return function (constructor: T) {
    return class extends constructor {
      public transfer: Transfer;

      constructor(...args: any[]) {
        super(...args);
        this.transfer = new Transfer(this, config);
      }

      // Override fetch to check for transfer endpoints
      async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url);

        try {
          // Determine if this is a readonly operation
          const isReadonly =
            request.method === "GET" && url.pathname === "/transfer/export";

          // Check authentication
          if (!this.transfer.checkAuth(request, !isReadonly)) {
            return this.transfer.unauthorizedResponse();
          }

          // Handle transfer endpoints
          if (url.pathname === "/transfer/export" && request.method === "GET") {
            const config = this.parseExportConfig(url.searchParams);
            return this.transfer.getExport(config);
          }

          if (
            url.pathname === "/transfer/import" &&
            request.method === "POST"
          ) {
            const result = await this.transfer.runFromFile(request);
            return new Response(JSON.stringify(result), {
              headers: { "Content-Type": "application/json" },
              status: result.success ? 200 : 400,
            });
          }

          // New endpoint: /transfer/import/{url}
          const importUrlMatch = url.pathname.match(
            /^\/transfer\/import\/(.+)$/,
          );
          if (importUrlMatch && request.method === "GET") {
            const importUrl = decodeURIComponent(importUrlMatch[1]);
            const authHeader = request.headers.get("X-Transfer-Auth");
            const auth = authHeader?.toLowerCase()?.startsWith("basic ")
              ? atob(authHeader.slice("basic ".length))
              : undefined;

            const result = await this.transfer.importFromUrl(importUrl, auth);
            return new Response(JSON.stringify(result), {
              headers: { "Content-Type": "application/json" },
              status: result.success ? 200 : 400,
            });
          }

          // New endpoint: /transfer/clear
          if (url.pathname === "/transfer/clear" && request.method === "POST") {
            const result = await this.transfer.clear();
            return new Response(JSON.stringify(result), {
              headers: { "Content-Type": "application/json" },
              status: result.success ? 200 : 500,
            });
          }

          if (url.pathname === "/transfer/dump" && request.method === "POST") {
            const config: DumpConfig = await request.json();
            const result = await this.transfer.dump(config);
            return new Response(JSON.stringify(result), {
              headers: { "Content-Type": "application/json" },
              status: result.success ? 200 : 500,
            });
          }

          // Call original fetch if it exists and is overridden
          if (super.fetch !== DurableObject.prototype.fetch) {
            return super.fetch(request);
          }

          return new Response("Not found", { status: 404 });
        } catch (error) {
          console.error("Transfer endpoint error:", error);
          return new Response(
            JSON.stringify({
              success: false,
              error: `Transfer operation failed: ${String(error)}`,
            }),
            {
              status: 500,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
      }

      private parseExportConfig(params: URLSearchParams): ExportConfig {
        return {
          includeSchema: params.get("includeSchema") !== "false",
          includeData: params.get("includeData") !== "false",
          tableWhitelist:
            params.get("tableWhitelist")?.split(",").filter(Boolean) || [],
          tableBlacklist:
            params.get("tableBlacklist")?.split(",").filter(Boolean) || [],
        };
      }
    } as any;
  };
}
