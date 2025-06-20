# Transferable Object

A comprehensive database import/export library for Cloudflare Durable Objects with SQLite storage. Supports streaming SQL dumps, R2 backups, and flexible import/export configurations.

## Features

- **SQL Export**: Stream database as SQL dump with comprehensive configuration options
- **SQL Import**: Import from SQL files with streaming support
- **R2 Backup**: Direct backup to R2 with exact size calculation using 2-pass approach
- **Flexible Configuration**: Table filtering, transaction wrapping, batch processing, and more
- **Two Usage Patterns**: Decorator or manual instantiation

## Installation

```
npm i transferable-object
```

## Usage

### Option 1: Using @Transferable Decorator

The decorator automatically adds transfer endpoints to your Durable Object's fetch handler:

```typescript
import { Transferable } from "./transferable-object";

@Transferable
export class MyDurableObject extends DurableObject {
  // Automatically adds these endpoints:
  // GET /transfer/export - Export database as SQL
  // POST /transfer/import - Import from SQL file
  // POST /transfer/dump - Backup to R2
}
```

**Added endpoints:**

- `GET /transfer/export?includeSchema=true&batchSize=1000` - Export with query params
- `POST /transfer/import` - Import SQL file from request body
- `POST /transfer/dump` - Backup to R2 (requires JSON config in body)

### Option 2: Manual Integration

Add transfer functionality to your existing Durable Object:

```typescript
import { Transfer, TransferInterface } from "./transferable-object";

export class MyDurableObject extends DurableObject {
  transfer: TransferInterface = new Transfer(this);

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Custom export endpoint
    if (url.pathname === "/backup") {
      return this.transfer.getExport({
        includeSchema: true,
        replaceInserts: true,
      });
    }

    // Backup to R2
    if (url.pathname === "/backup-to-r2") {
      const result = await this.transfer.dump({
        bucketName: "MY_R2_BUCKET",
        key: `backup-${Date.now()}.sql`,
      });
      return Response.json(result);
    }

    // Your existing logic...
  }
}
```

## API Reference

### `getExport(config?: ExportConfig): Promise<Response>`

Exports database as streaming SQL dump.

**Config options:**

- `dropTablesIfExist` - Add DROP TABLE statements
- `includeSchema` - Include table structure (default: true)
- `includeData` - Include table data (default: true)
- `tableWhitelist/tableBlacklist` - Filter tables
- `addTransaction` - Wrap in transaction (default: true)
- `batchSize` - Rows per INSERT batch (default: 1000)
- `replaceInserts` - Use REPLACE instead of INSERT
- `insertIgnore` - Use INSERT OR IGNORE

### `runFromFile(request: Request): Promise<ImportResult>`

Imports SQL from request body stream.

### `dump(config: DumpConfig): Promise<{success, key, size}>`

Backs up database to R2 bucket with exact size calculation.

**Config:**

```typescript
{
  bucketName: string;    // R2 bucket environment variable name
  key: string;           // Object key in bucket
  exportConfig?: ExportConfig;  // Optional export configuration
}
```

## Requirements

- Cloudflare Workers with Durable Objects
- R2 bucket binding (for dump functionality)
- SQLite storage in Durable Object
