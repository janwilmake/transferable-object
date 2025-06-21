import { DurableObject } from "cloudflare:workers";
import { Transfer } from "./transferable-object";

// add this if you also want to add fetch middleware
// @Transferable
export class ExampleDO extends DurableObject {
  transfer = new Transfer(this);

  async alarm() {
    // STREAMS .sql FILE TO R2!!!
    await this.transfer.dump({
      r2BucketBindingName: "MY_R2_BUCKET",
      key: `daily-db-dump.sql`,
    });
  }

  constructor(ctx: DurableObjectState, env: any) {
    super(ctx, env);

    // Create dummy table and data
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY,
        name TEXT,
        email TEXT
      )
    `);

    // Insert some dummy data (only if table is empty)
    const count = this.ctx.storage.sql
      .exec("SELECT COUNT(*) as count FROM users")
      .one();
    if (count.count === 0) {
      this.ctx.storage.sql.exec(`
        INSERT INTO users (name, email) VALUES 
        ('Alice', 'alice@example.com'),
        ('Bob', 'bob@example.com'),
        ('Charlie', 'charlie@example.com')
      `);
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/my-custom-export") {
      // Use the transfer functionality
      return this.transfer.getExport({
        includeSchema: true,
        replaceInserts: true,
      });
    }

    if (url.pathname === "/backup-to-r2") {
      const result = await this.transfer.dump({
        r2BucketBindingName: "MY_R2_BUCKET",
        key: `daily-backup.sql`,
      });

      return new Response(JSON.stringify(result));
    }

    // Your regular DO logic here
    return new Response("Hello from DO!");
  }
}

// Worker handler
export default {
  async fetch(request: Request, env: any): Promise<Response> {
    const doId = env.EXAMPLE_DO.idFromName("example3");
    const doStub = env.EXAMPLE_DO.get(doId);
    return doStub.fetch(request);
  },
};
