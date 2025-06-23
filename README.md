# Transferable Object

A database import/export library for Cloudflare Durable Objects with SQLite storage. Enables cross-DO data transfer using streaming SQL cursors.

## Installation

```bash
npm i transferable-object remote-sql-cursor
```

## Usage

**⚠️ Important: `@Streamable()` decorator is required for both patterns**

### Pattern 1: Decorator (Recommended)

```typescript
import { Streamable } from "remote-sql-cursor";
import { Transferable } from "transferable-object";

@Streamable()
@Transferable({ secret: "user:pass" })
export class MyDurableObject extends DurableObject {
  // Automatically adds transfer endpoints:
  // GET /transfer/import/{url} - Import from remote DO
  // POST /transfer/clear - Clear all data
}
```

### Pattern 2: Manual Integration

```typescript
import { Streamable } from "remote-sql-cursor";
import { Transfer } from "transferable-object";

@Streamable()
export class MyDurableObject extends DurableObject {
  transfer = new Transfer(this, { secret: "user:pass" });

  async fetch(request: Request) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/transfer/")) {
      // Handle auth
      if (!this.transfer.checkAuth(request)) {
        return this.transfer.unauthorizedResponse();
      }

      // Import from URL
      if (url.pathname.match(/^\/transfer\/import\/(.+)$/)) {
        const sourceUrl = decodeURIComponent(RegExp.$1);
        const result = await this.transfer.importFromUrl(sourceUrl);
        return Response.json(result);
      }

      // Clear data
      if (url.pathname === "/transfer/clear" && request.method === "POST") {
        const result = await this.transfer.clear();
        return Response.json(result);
      }
    }

    // Your existing logic...
  }
}
```

## Cross-DO Cloning

```typescript
import { clone } from "transferable-object";

await clone("https://source-do-url", "https://dest-do-url", {
  clearOnImport: true,
  exportBasicAuth: "user:pass",
  importBasicAuth: "user:pass",
});
```

## Authentication

- Uses Basic Auth when `secret` is configured
- `isReadonlyPublic: true` - Allow unauthenticated read operations
- Pass credentials via `Authorization` header or `?apiKey=` query param
