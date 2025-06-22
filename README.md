# Transferable Object

A database import/export library for Cloudflare Durable Objects with SQLite storage. Supports streaming SQL dumps, R2 backups, cross-DO cloning, and authentication.

## Installation

```bash
npm i transferable-object
```

## Quick Start

### Decorator Pattern (Recommended)

```typescript
import { Transferable } from "transferable-object";

@Transferable({ secret: "user:pass", isReadonlyPublic: true })
export class MyDurableObject extends DurableObject {
  // Automatically adds transfer endpoints
}
```

### Manual Integration

```typescript
import { Transfer } from "transferable-object";

export class MyDurableObject extends DurableObject {
  transfer = new Transfer(this, { secret: "user:pass" });

  async fetch(request: Request) {
    if (url.pathname === "/backup") {
      return this.transfer.getExport();
    }
    // ... your logic
  }
}
```

## Endpoints (Decorator)

- `GET /transfer/export` - Export as SQL dump
- `POST /transfer/import` - Import from SQL body
- `POST /transfer/clear` - Clear all data
- `POST /transfer/dump` - Backup to R2

## API Methods

### Export

```typescript
await transfer.getExport({
  includeSchema: true, // Include CREATE TABLE
  includeData: true, // Include INSERT statements
  tableWhitelist: [], // Only these tables
  tableBlacklist: [], // Exclude these tables
  batchSize: 1000, // Rows per INSERT
  comments: true, // Add SQL comments
});
```

### Import

```typescript
await transfer.runFromFile(request);
await transfer.importFromUrl("https://other-do/transfer/export", "user:pass");
```

### R2 Backup

```typescript
await transfer.dump({
  r2BucketBindingName: "MY_BUCKET",
  key: `backup-${Date.now()}.sql`,
  exportConfig: { ... }
});
```

### Clone Between DOs

```typescript
import { clone } from "transferable-object";

await clone(
  "https://source-do/transfer/export",
  "https://dest-do/transfer/import",
  {
    clearOnImport: true,
    exportBasicAuth: "user:pass",
    importBasicAuth: "user:pass",
  },
);
```

## Authentication

Configure with `secret` option. Supports Basic Auth (`user:pass`).

- `isReadonlyPublic: true` - Allow unauthenticated exports
- All other operations require authentication when secret is set

## Features

- **Streaming**: Handles large databases efficiently
- **Safe Execution**: Comprehensive error handling and recovery
- **Cross-DO Cloning**: Direct database migration between instances
- **R2 Integration**: Fixed-size streaming backups
- **Flexible Filtering**: Table whitelist/blacklist support
- **Authentication**: Basic Auth with readonly public option
