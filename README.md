# Transferable Object

Installation

```
npm i transferable-object
```

Usage

```
@Transferable
export class ExampleDO extends DurableObject {
    // ...your DO code
}
```

Now your DO gets `/import` and `/export` endpoints made accessible in its fetch. See example below on how this can be used.

# Example

1. **Export the database:**

```bash
curl http://localhost:3000/export --output database_export.sql
```

2. **View the exported data:**

```bash
cat database_export.sql
```

3. **Import the database (after modifying the SQL file):**

```bash
curl -X POST http://localhost:3000/import --data-binary @database_export.sql
```

4. **Test with modified data:**

```bash
# First export
curl http://localhost:3000/export -o original.sql

# Modify the SQL file (add more data)
echo "INSERT INTO users (name, email) VALUES ('David', 'david@example.com');" >> original.sql

# Import the modified data
curl -X POST http://localhost:3000/import --data-binary @original.sql

# Export again to verify
curl http://localhost:3000/export -o modified.sql
```

The decorator automatically handles the `/export` and `/import` endpoints, so you get database transfer functionality without writing any additional code!
