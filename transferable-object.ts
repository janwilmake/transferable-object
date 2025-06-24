// @ts-check
/// <reference lib="esnext" />
/// <reference types="@cloudflare/workers-types" />

import { DurableObject } from "cloudflare:workers";
import { exec, makeStub } from "remote-sql-cursor";

export interface ImportResult {
  success: boolean;
  tablesCreated: string[];
  rowsImported: number;
  errors?: string[];
  warnings?: string[];
}

export interface TransferableConfig {
  secret?: string;
  isReadonlyPublic?: boolean;
}

// Simple Transfer class using remote-sql-cursor
export class Transfer {
  storage: DurableObjectStorage;
  private config: TransferableConfig;

  constructor(
    private durableObject: DurableObject,
    config: TransferableConfig = {},
  ) {
    //@ts-ignore
    this.storage = durableObject.ctx.storage;
    this.config = config;
  }

  // Authentication helper
  checkAuth(request: Request, requireAuth: boolean = true): boolean {
    if (!this.config.secret) return true;
    if (!requireAuth && this.config.isReadonlyPublic) return true;

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

  // Safe query execution with error handling
  private safeExec(
    query: string,
    ...params: any[]
  ): {
    success: boolean;
    rowsAffected?: number;
    error?: string;
  } {
    try {
      const result = this.storage.sql.exec(query, ...params);
      return {
        success: true,
        rowsAffected: result.rowsWritten || 0,
      };
    } catch (error) {
      console.error(`Query failed: ${query}`, error);
      return {
        success: false,
        error: String(error),
      };
    }
  }

  // Import from URL using remote-sql-cursor
  async importFromUrl(url: string, authHeader?: string): Promise<ImportResult> {
    const errors: string[] = [];
    const warnings: string[] = [];
    const tablesCreated: string[] = [];
    let rowsImported = 0;

    try {
      // Create stub for the remote database
      const stub = makeStub(url, { Authorization: authHeader });

      // Step 1: Get all tables from remote database
      console.log("Getting table list from remote database...");
      const tablesCursor = exec(
        stub,
        undefined,
        `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'`,
      );

      const tables = await tablesCursor.toArray();
      console.log(`Found ${tables.length} tables to import`);

      if (tables.length === 0) {
        warnings.push("No tables found in remote database");
        return {
          success: true,
          tablesCreated,
          rowsImported,
          warnings,
        };
      }

      // Step 2: For each table, get schema and create locally
      for (const table of tables) {
        const tableName = table.name as string;
        console.log(`Processing table: ${tableName}`);

        try {
          // Get the CREATE TABLE statement from remote
          const schemaCursor = exec(
            stub,
            undefined,
            `SELECT sql FROM sqlite_master WHERE type='table' AND name = ?`,
            tableName,
          );

          const schemaResult = await schemaCursor.toArray();
          if (schemaResult.length === 0) {
            warnings.push(`Could not get schema for table: ${tableName}`);
            continue;
          }

          const createTableSQL = schemaResult[0].sql as string;

          // Convert to CREATE TABLE IF NOT EXISTS for safer imports
          const safeCreateSQL = createTableSQL.replace(
            /CREATE TABLE\s+/i,
            "CREATE TABLE IF NOT EXISTS ",
          );

          // Create table locally
          const createResult = this.safeExec(safeCreateSQL);
          if (!createResult.success) {
            errors.push(
              `Failed to create table ${tableName}: ${createResult.error}`,
            );
            continue;
          }

          tablesCreated.push(tableName);
          console.log(`Created table: ${tableName}`);

          // Step 3: Get column information for parameterized inserts
          const columnsCursor = exec(
            stub,
            undefined,
            `PRAGMA table_info(${tableName})`,
          );

          const columnsInfo = await columnsCursor.toArray();
          const columnNames = columnsInfo.map((col: any) => col.name as string);

          if (columnNames.length === 0) {
            warnings.push(`No columns found for table: ${tableName}`);
            continue;
          }

          console.log(
            `Table ${tableName} has columns: ${columnNames.join(", ")}`,
          );

          // Step 4: Stream all data from remote table and insert row by row
          const dataCursor = exec(
            stub,
            undefined,
            `SELECT * FROM ${tableName}`,
          );

          let tableRowCount = 0;
          const placeholders = columnNames.map(() => "?").join(", ");
          const insertSQL = `INSERT OR IGNORE INTO ${tableName} (${columnNames.join(
            ", ",
          )}) VALUES (${placeholders})`;

          // Stream and insert each row
          for await (const row of dataCursor) {
            try {
              // Extract values in column order
              const values = columnNames.map((col) => row[col]);

              // Insert single row with parameters
              const insertResult = this.safeExec(insertSQL, ...values);
              if (
                insertResult.success &&
                insertResult.rowsAffected &&
                insertResult.rowsAffected > 0
              ) {
                tableRowCount++;
                rowsImported++;
              }

              // Log progress periodically
              if (tableRowCount % 1000 === 0 && tableRowCount !== 0) {
                console.log(
                  `Imported ${tableRowCount} rows to ${tableName}...`,
                );
              }
            } catch (rowError) {
              warnings.push(
                `Failed to insert row in ${tableName}: ${String(rowError)}`,
              );
            }
          }

          console.log(
            `Completed table ${tableName}: ${tableRowCount} rows imported`,
          );
        } catch (tableError) {
          errors.push(
            `Failed to process table ${tableName}: ${String(tableError)}`,
          );
        }
      }

      return {
        success: errors.length === 0,
        tablesCreated,
        rowsImported,
        errors: errors.length > 0 ? errors : undefined,
        warnings: warnings.length > 0 ? warnings : undefined,
      };
    } catch (error) {
      return {
        success: false,
        tablesCreated,
        rowsImported,
        errors: [`Import failed: ${String(error)}`],
        warnings: warnings.length > 0 ? warnings : undefined,
      };
    }
  }

  // Clear all data from the DO instance
  async clear(): Promise<{
    success: boolean;
    errors?: string[];
  }> {
    const errors: string[] = [];

    try {
      // Clear alarm
      const alarm = await this.storage.getAlarm();
      if (alarm) {
        await this.storage.deleteAlarm();
      }

      // Clear storage
      await this.storage.deleteAll({});

      return {
        success: errors.length === 0,
        errors: errors.length > 0 ? errors : undefined,
      };
    } catch (error) {
      return {
        success: false,
        errors: [...errors, `Clear operation failed: ${String(error)}`],
      };
    }
  }
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
      async fetch(request: Request) {
        const url = new URL(request.url);

        try {
          // Check authentication for write operations
          const isReadonly = false; // All our operations are write operations
          if (!this.transfer.checkAuth(request, !isReadonly)) {
            return this.transfer.unauthorizedResponse();
          }

          // Handle transfer endpoints
          const importUrlMatch = url.pathname.match(
            /^\/transfer\/import\/(.+)$/,
          );
          if (importUrlMatch && request.method === "GET") {
            const importUrl = decodeURIComponent(importUrlMatch[1]);
            const credentials = url.searchParams.get("credentials");
            const authHeader = credentials
              ? `Basic ${btoa(credentials)}`
              : undefined;

            const result = await this.transfer.importFromUrl(
              importUrl,
              authHeader,
            );
            return new Response(JSON.stringify(result, undefined, 2), {
              headers: { "Content-Type": "application/json" },
              status: result.success ? 200 : 400,
            });
          }

          // Clear endpoint
          if (url.pathname === "/transfer/clear" && request.method === "POST") {
            const result = await this.transfer.clear();
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
    } as any;
  };
}

// Utility function for cloning between DO instances
export async function clone(
  exportUrl: string,
  importUrl: string,
  config: {
    clearOnImport?: boolean;
    clearAfterExport?: boolean;
    exportBasicAuth?: string;
    importBasicAuth?: string;
  } = {},
): Promise<{
  success: boolean;
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

    // Import from source to destination
    const importHeaders: HeadersInit = {};
    if (importBasicAuth) {
      importHeaders["Authorization"] = `Basic ${btoa(importBasicAuth)}`;
    }
    if (exportBasicAuth) {
      importHeaders["X-Transfer-Auth"] = `Basic ${btoa(exportBasicAuth)}`;
    }

    const importResponse = await fetch(
      `${importUrl}/transfer/import/${encodeURIComponent(exportUrl)}`,
      {
        method: "GET",
        headers: importHeaders,
      },
    );

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
