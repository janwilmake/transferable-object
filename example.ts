import { DurableObject } from "cloudflare:workers";
import { Transferable } from "./transferable-object";

@Transferable
export class ExampleDO extends DurableObject {
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

  fetch() {
    const users = this.ctx.storage.sql.exec("SELECT * FROM users").toArray();
    return new Response(
      "Hello,world!\n\n" + JSON.stringify(users, undefined, 2),
    );
  }
}

// Worker handler
export default {
  async fetch(request: Request, env: any): Promise<Response> {
    const doId = env.EXAMPLE_DO.idFromName("example2");
    const doStub = env.EXAMPLE_DO.get(doId);
    return doStub.fetch(request);
  },
};
