// @ts-check
/// <reference lib="esnext" />
/// <reference types="@cloudflare/workers-types" />

import { DurableObject } from "cloudflare:workers";

// Base transferable class that properly extends DurableObject
export class TransferableDO extends DurableObject {
  // Export database as SQL dump (streaming)
  async getExport(): Promise<Response> {
    const readable = new ReadableStream({
      start: (controller) => {
        try {
          // Get all tables (excluding SQLite system tables)
          const tables = this.ctx.storage.sql
            .exec(
              `
            SELECT name FROM sqlite_master 
            WHERE type='table' AND name NOT LIKE 'sqlite_%'
          `,
            )
            .toArray();

          // Export schema first
          for (const table of tables) {
            const tableName = table.name as string;

            // Get CREATE TABLE statement
            const createStmt = this.ctx.storage.sql
              .exec(
                `
              SELECT sql FROM sqlite_master 
              WHERE type='table' AND name = ?
            `,
                tableName,
              )
              .one();

            const modifiedSql = (createStmt.sql as string).replace(
              /CREATE TABLE\s+/i,
              "CREATE TABLE IF NOT EXISTS ",
            );

            controller.enqueue(
              new TextEncoder().encode(
                `-- Table: ${tableName}\n${modifiedSql};\n\n`,
              ),
            );
          }

          // Export data
          for (const table of tables) {
            const tableName = table.name as string;

            controller.enqueue(
              new TextEncoder().encode(`-- Data for table: ${tableName}\n`),
            );

            // Get all rows and convert to INSERT statements
            const rows = this.ctx.storage.sql.exec(
              `SELECT * FROM ${tableName}`,
            );
            let result: any;
            while (!(result = rows.next()).done) {
              const row: Record<string, SqlStorageValue> = result.value;
              const columns = Object.keys(row);
              const values = Object.values(row).map((val) => {
                if (val === null) return "NULL";
                if (typeof val === "string") {
                  // Escape single quotes
                  return `'${val.replace(/'/g, "''")}'`;
                }
                return String(val);
              });

              const insertStmt = `INSERT INTO ${tableName} (${columns.join(
                ", ",
              )}) VALUES (${values.join(", ")});\n`;
              controller.enqueue(new TextEncoder().encode(insertStmt));
            }

            controller.enqueue(new TextEncoder().encode("\n"));
          }

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
      },
    });
  }

  // Import from SQL file (streaming)
  async runFromFile(request: Request): Promise<Response> {
    if (!request.body) {
      return new Response("No SQL file provided", { status: 400 });
    }

    const reader = request.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let executedStatements = 0;
    let errors: string[] = [];

    try {
      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          // Process any remaining statements in buffer
          if (buffer.trim()) {
            const statements = this.parseSQLStatements(buffer);
            for (const stmt of statements) {
              try {
                this.ctx.storage.sql.exec(stmt);
                executedStatements++;
              } catch (error) {
                errors.push(
                  `Error executing: ${stmt.substring(0, 50)}...: ${error}`,
                );
              }
            }
          }
          break;
        }

        buffer += decoder.decode(value, { stream: true });

        // Process complete statements (those ending with ;)
        const statements = this.parseSQLStatements(buffer);

        // Keep the last incomplete statement in buffer
        const lastSemicolon = buffer.lastIndexOf(";");
        if (lastSemicolon !== -1) {
          buffer = buffer.substring(lastSemicolon + 1);

          // Execute complete statements
          for (const stmt of statements) {
            try {
              this.ctx.storage.sql.exec(stmt);
              executedStatements++;
            } catch (error) {
              errors.push(
                `Error executing: ${stmt.substring(0, 50)}...: ${error}`,
              );
            }
          }
        }
      }

      return new Response(
        JSON.stringify({
          success: true,
          executedStatements,
          errors: errors.length > 0 ? errors : undefined,
        }),
        {
          headers: { "Content-Type": "application/json" },
        },
      );
    } catch (error) {
      return new Response(
        JSON.stringify({
          success: false,
          error: String(error),
          executedStatements,
          errors,
        }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" },
        },
      );
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

  // Check if this is a transfer request
  async handleTransferRequest(request: Request): Promise<Response | null> {
    const url = new URL(request.url);

    if (url.pathname === "/export" && request.method === "GET") {
      return this.getExport();
    }

    if (url.pathname === "/import" && request.method === "POST") {
      return this.runFromFile(request);
    }

    // Return null to indicate this request should be handled by your app logic
    return null;
  }

  // Override fetch to handle transfer requests automatically
  async fetch(request: Request): Promise<Response> {
    // First check if this is a transfer request
    const transferResponse = await this.handleTransferRequest(request);
    if (transferResponse) {
      return transferResponse;
    }

    // Default fallback - should be overridden by subclasses
    return new Response("Not found", { status: 404 });
  }
}

// Decorator function that adds transferable functionality
export function Transferable<T extends new (...args: any[]) => DurableObject>(
  constructor: T,
) {
  // Create a new class that extends TransferableDO and properly calls the original constructor
  return class extends TransferableDO {
    private originalInstance: InstanceType<T>;

    constructor(...args: any[]) {
      // Call the parent constructor first
      super(args[0], args[1]);

      // Create an instance of the original class and copy its properties
      // We need to create it with the same arguments
      this.originalInstance = new constructor(...args) as InstanceType<T>;

      // Copy all enumerable properties from the original instance
      const originalProps = Object.getOwnPropertyNames(this.originalInstance);
      for (const prop of originalProps) {
        if (prop !== "constructor" && prop !== "ctx" && prop !== "env") {
          try {
            const descriptor = Object.getOwnPropertyDescriptor(
              this.originalInstance,
              prop,
            );
            if (descriptor) {
              Object.defineProperty(this, prop, descriptor);
            }
          } catch (e) {
            // Some properties might not be configurable, skip them
          }
        }
      }
    }

    // Override fetch to first check for transfer requests, then delegate to original class logic
    async fetch(request: Request): Promise<Response> {
      // First check if this is a transfer request
      console.log("transferable req", request.url);
      const transferResponse = await this.handleTransferRequest(request);
      if (transferResponse) {
        return transferResponse;
      }

      // Delegate to the original instance's fetch method if it exists
      if (
        this.originalInstance &&
        typeof this.originalInstance.fetch === "function"
      ) {
        return this.originalInstance.fetch.call(this, request);
      }

      // Check if the original constructor's prototype has a fetch method
      const originalProto = constructor.prototype;
      if (
        originalProto.fetch &&
        originalProto.fetch !== DurableObject.prototype.fetch
      ) {
        // Call the original fetch method in the context of this instance
        return originalProto.fetch.call(this, request);
      }

      // Default fallback
      return new Response("Not found", { status: 404 });
    }
  } as any; // Type assertion needed for complex decorator typing
}

// Export the interface for type checking
export interface TransferableMethods {
  getExport(): Promise<Response>;
  runFromFile(request: Request): Promise<Response>;
  parseSQLStatements(text: string): string[];
  handleTransferRequest(request: Request): Promise<Response | null>;
}
