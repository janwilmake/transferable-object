// @ts-check
/// <reference lib="esnext" />
/// <reference types="@cloudflare/workers-types" />
// 2-pass implementation. see https://lmpify.com/httpspastebincon-hgdpah0

import { DurableObject } from "cloudflare:workers";

// Configuration interfaces
export interface ExportConfig {
  dropTablesIfExist?: boolean;
  includeSchema?: boolean;
  includeData?: boolean;
  tableWhitelist?: string[];
  tableBlacklist?: string[];
  addTransaction?: boolean;
  disableForeignKeyChecks?: boolean;
  insertIgnore?: boolean;
  replaceInserts?: boolean;
  batchSize?: number;
  comments?: boolean;
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
}

// Transfer class that provides all functionality
export class Transfer {
  sql: SqlStorage;

  constructor(private durableObject: DurableObject) {
    //@ts-ignore (it works idk why complain)
    this.sql = durableObject.ctx.storage.sql;
  }

  // Export database as SQL dump with comprehensive config
  async getExport(config: ExportConfig = {}): Promise<Response> {
    const {
      dropTablesIfExist = false,
      includeSchema = true,
      includeData = true,
      tableWhitelist = [],
      tableBlacklist = [],
      addTransaction = true,
      disableForeignKeyChecks = false,
      insertIgnore = false,
      replaceInserts = false,
      batchSize = 1000,
      comments = true,
    } = config;

    let exportedTables: string[] = [];
    let totalRows = 0;

    const readable = new ReadableStream({
      start: (controller) => {
        try {
          const writeHeader = () => {
            if (comments) {
              controller.enqueue(
                new TextEncoder().encode(
                  `-- Database Export\n-- Generated: ${new Date().toISOString()}\n\n\n`,
                ),
              );
            }

            if (disableForeignKeyChecks) {
              controller.enqueue(
                new TextEncoder().encode("PRAGMA foreign_keys = OFF;\n\n"),
              );
            }

            if (addTransaction) {
              controller.enqueue(
                new TextEncoder().encode("BEGIN TRANSACTION;\n\n"),
              );
            }
          };

          const writeFooter = () => {
            if (addTransaction) {
              controller.enqueue(new TextEncoder().encode("\nCOMMIT;\n"));
            }

            if (disableForeignKeyChecks) {
              controller.enqueue(
                new TextEncoder().encode("PRAGMA foreign_keys = ON;\n"),
              );
            }

            if (comments) {
              controller.enqueue(
                new TextEncoder().encode(
                  `\n-- Export completed\n-- Tables: ${exportedTables.length}\n-- Total rows: ${totalRows}\n`,
                ),
              );
            }
          };

          writeHeader();

          // Get all tables (excluding SQLite system tables)
          const allTables = this.sql
            .exec(
              `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`,
            )
            .toArray();

          // Filter tables based on whitelist/blacklist
          const tables = allTables.filter((table) => {
            const tableName = table.name as string;

            if (tableWhitelist.length > 0) {
              return tableWhitelist.includes(tableName);
            }

            if (tableBlacklist.length > 0) {
              return !tableBlacklist.includes(tableName);
            }

            return true;
          });

          exportedTables = tables.map((t) => t.name as string);

          // Export schema
          if (includeSchema) {
            for (const table of tables) {
              const tableName = table.name as string;

              if (comments) {
                controller.enqueue(
                  new TextEncoder().encode(
                    `\n-- Table structure for ${tableName}\n`,
                  ),
                );
              }

              // Drop table if requested
              if (dropTablesIfExist) {
                controller.enqueue(
                  new TextEncoder().encode(
                    `DROP TABLE IF EXISTS ${tableName};\n`,
                  ),
                );
              }

              // Get CREATE TABLE statement
              const createStmt = this.sql
                .exec(
                  `SELECT sql FROM sqlite_master WHERE type='table' AND name = ?`,
                  tableName,
                )
                .one();

              let sql = createStmt.sql as string;
              if (!dropTablesIfExist) {
                sql = sql.replace(
                  /CREATE TABLE\s+/i,
                  "CREATE TABLE IF NOT EXISTS ",
                );
              }

              controller.enqueue(new TextEncoder().encode(`${sql};\n\n`));
            }

            // Export indexes
            const indexes = this.sql
              .exec(
                `SELECT sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL`,
              )
              .toArray();

            if (indexes.length > 0 && comments) {
              controller.enqueue(new TextEncoder().encode(`-- Indexes\n`));
            }

            for (const index of indexes) {
              controller.enqueue(new TextEncoder().encode(`${index.sql};\n`));
            }

            if (indexes.length > 0) {
              controller.enqueue(new TextEncoder().encode("\n"));
            }
          }

          // Export data
          if (includeData) {
            for (const table of tables) {
              const tableName = table.name as string;

              if (comments) {
                controller.enqueue(
                  new TextEncoder().encode(
                    `\n-- Data for table ${tableName}\n`,
                  ),
                );
              }

              // Get column info for proper escaping
              const columns = this.sql
                .exec(`PRAGMA table_info(${tableName})`)
                .toArray()
                .map((col) => col.name as string);

              // Stream data in batches
              let offset = 0;
              let batchCount = 0;

              while (true) {
                const rows = this.sql
                  .exec(
                    `SELECT * FROM ${tableName} LIMIT ? OFFSET ?`,
                    batchSize,
                    offset,
                  )
                  .toArray();

                if (rows.length === 0) break;

                // Build batch INSERT
                const insertType = replaceInserts
                  ? "REPLACE"
                  : insertIgnore
                  ? "INSERT OR IGNORE"
                  : "INSERT";
                const values = rows.map((row) => {
                  const rowValues = columns.map((col) => {
                    const val = (row as any)[col];
                    if (val === null) return "NULL";
                    if (typeof val === "string") {
                      return `'${val.replace(/'/g, "''")}'`;
                    }
                    if (val instanceof ArrayBuffer) {
                      return `X'${Array.from(new Uint8Array(val))
                        .map((b) => b.toString(16).padStart(2, "0"))
                        .join("")}'`;
                    }
                    return String(val);
                  });
                  return `(${rowValues.join(", ")})`;
                });

                const insertStmt = `${insertType} INTO ${tableName} (${columns.join(
                  ", ",
                )}) VALUES\n${values.join(",\n")};\n`;
                controller.enqueue(new TextEncoder().encode(insertStmt));

                totalRows += rows.length;
                offset += batchSize;
                batchCount++;

                // Add some spacing between large batches
                if (batchCount % 10 === 0) {
                  controller.enqueue(new TextEncoder().encode("\n"));
                }
              }

              controller.enqueue(new TextEncoder().encode("\n"));
            }
          }

          writeFooter();
          controller.close();
        } catch (error) {
          controller.error(error);
        }
      },
    });

    return new Response(readable, {
      headers: {
        "Content-Type": "application/sql",
        "Content-Disposition": 'attachment; filename="database_export.sql"',
        "X-Exported-Tables": exportedTables.join(","),
        "X-Total-Rows": totalRows.toString(),
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
              const result = this.executeStatement(stmt);
              executedStatements++;
              if (result.error) {
                errors.push(result.error);
              } else {
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
            const result = this.executeStatement(stmt);
            executedStatements++;
            if (result.error) {
              errors.push(result.error);
            } else {
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
        tablesCreated,
        rowsInserted,
      };
    } catch (error) {
      return {
        success: false,
        executedStatements,
        errors: [...errors, String(error)],
        tablesCreated,
        rowsInserted,
      };
    }
  }

  // Dump to R2 bucket with exact sizing using 2-pass approach
  async dump(
    config: DumpConfig,
  ): Promise<{ success: boolean; key: string; size: number }> {
    const { r2BucketBindingName, key, exportConfig = {} } = config;

    // Get the bucket
    const bucket = ((this.durableObject as any).env as any)[
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
        "database-size": this.sql.databaseSize.toString(),
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

    return {
      success: true,
      key: result.key,
      size: exactSize,
    };
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

  private executeStatement(statement: string): {
    error?: string;
    tableCreated?: string;
    rowsAffected?: number;
  } {
    try {
      const result = this.sql.exec(statement);

      // Check if this created a table
      const createTableMatch = statement.match(
        /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/i,
      );
      const tableCreated = createTableMatch ? createTableMatch[1] : undefined;

      // Get rows affected for INSERT/UPDATE/DELETE
      const rowsAffected = result.rowsWritten || 0;

      return { tableCreated, rowsAffected };
    } catch (error) {
      return {
        error: `Error executing: ${statement.substring(0, 50)}...: ${error}`,
      };
    }
  }
}

// Transfer interface for type checking
export interface TransferInterface {
  getExport(config?: ExportConfig): Promise<Response>;
  runFromFile(request: Request): Promise<ImportResult>;
  dump(
    config: DumpConfig,
  ): Promise<{ success: boolean; key: string; size: number }>;
}

// Decorator function that adds transferable functionality
export function Transferable<T extends new (...args: any[]) => DurableObject>(
  constructor: T,
) {
  return class extends constructor {
    public transfer: Transfer;

    constructor(...args: any[]) {
      super(...args);
      this.transfer = new Transfer(this);
    }

    // Override fetch to check for transfer endpoints
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);

      // Handle transfer endpoints
      if (url.pathname === "/transfer/export" && request.method === "GET") {
        const config = this.parseExportConfig(url.searchParams);
        return this.transfer.getExport(config);
      }

      if (url.pathname === "/transfer/import" && request.method === "POST") {
        const result = await this.transfer.runFromFile(request);
        return new Response(JSON.stringify(result), {
          headers: { "Content-Type": "application/json" },
          status: result.success ? 200 : 400,
        });
      }

      if (url.pathname === "/transfer/dump" && request.method === "POST") {
        try {
          const config: DumpConfig = await request.json();
          const result = await this.transfer.dump(config);
          return new Response(JSON.stringify(result), {
            headers: { "Content-Type": "application/json" },
          });
        } catch (error) {
          return new Response(
            JSON.stringify({
              success: false,
              error: String(error),
            }),
            {
              status: 400,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
      }

      // Call original fetch if it exists and is overridden
      if (super.fetch !== DurableObject.prototype.fetch) {
        return super.fetch(request);
      }

      return new Response("Not found", { status: 404 });
    }

    private parseExportConfig(params: URLSearchParams): ExportConfig {
      return {
        dropTablesIfExist: params.get("dropTablesIfExist") === "true",
        includeSchema: params.get("includeSchema") !== "false",
        includeData: params.get("includeData") !== "false",
        tableWhitelist:
          params.get("tableWhitelist")?.split(",").filter(Boolean) || [],
        tableBlacklist:
          params.get("tableBlacklist")?.split(",").filter(Boolean) || [],
        addTransaction: params.get("addTransaction") !== "false",
        disableForeignKeyChecks:
          params.get("disableForeignKeyChecks") === "true",
        insertIgnore: params.get("insertIgnore") === "true",
        replaceInserts: params.get("replaceInserts") === "true",
        batchSize: parseInt(params.get("batchSize") || "1000"),
        comments: params.get("comments") !== "false",
      };
    }
  } as any;
}
