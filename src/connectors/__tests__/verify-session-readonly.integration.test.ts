import { describe, it, afterAll } from "vitest";
import { MySqlContainer, StartedMySqlContainer } from "@testcontainers/mysql";
import { MariaDbContainer, StartedMariaDbContainer } from "@testcontainers/mariadb";
import mysql from "mysql2/promise";
import mariadb from "mariadb";

// Throwaway probe (not for upstream): records what MySQL / MariaDB do with DDL and
// DML under (a) START TRANSACTION READ ONLY only, as DBHub does today, and
// (b) SET SESSION TRANSACTION READ ONLY.

type Q = (sql: string) => Promise<unknown>;

async function probe(flavor: string, q: Q): Promise<void> {
  const run = async (step: string, sql: string) => {
    let outcome: string;
    try {
      await q(sql);
      outcome = "OK";
    } catch (e: any) {
      outcome = `ERR ${e.errno ?? e.code ?? ""} ${String(e.sqlMessage ?? e.message).slice(0, 90)}`;
    }
    console.log(`RESULT\t${flavor}\t${step}\t${sql}\t${outcome}`);
  };

  await run("setup", "CREATE TABLE base (id INT PRIMARY KEY)");
  await run("setup", "INSERT INTO base VALUES (1)");

  // (a) today's DBHub read-only path: per-execution READ ONLY transaction
  await run("a:txn-ro", "START TRANSACTION READ ONLY");
  await run("a:txn-ro", "INSERT INTO base VALUES (2)");
  await run("a:txn-ro", "ROLLBACK");
  await run("a:txn-ro", "START TRANSACTION READ ONLY");
  await run("a:txn-ro", "CREATE TABLE a_created (id INT)");
  await run("a:txn-ro", "ROLLBACK");
  await run("a:check", "SELECT 1 FROM a_created");

  // (b) session-level read only
  await run("b:session-ro", "SET SESSION TRANSACTION READ ONLY");
  for (const sql of [
    "SELECT COUNT(*) FROM base",
    "INSERT INTO base VALUES (3)",
    "UPDATE base SET id = 10 WHERE id = 1",
    "DELETE FROM base",
    "CREATE TABLE b_created (id INT)",
    "ALTER TABLE base ADD COLUMN c INT",
    "CREATE INDEX idx_b ON base (id)",
    "RENAME TABLE base TO base_renamed",
    "TRUNCATE TABLE base",
    "DROP TABLE base",
    "CREATE TEMPORARY TABLE tmp_b (id INT)",
  ]) {
    await run("b:session-ro", sql);
  }
  // (b') session read only + DBHub's per-execution READ ONLY transaction
  await run("b2:both", "START TRANSACTION READ ONLY");
  await run("b2:both", "DROP TABLE base");
  await run("b2:both", "ROLLBACK");
  // can the session switch itself back?
  await run("c:revert", "SET SESSION TRANSACTION READ WRITE");
  await run("c:revert", "CREATE TABLE c_created (id INT)");
}

describe("probe: session read only vs DDL", () => {
  let my: StartedMySqlContainer | undefined;
  let ma: StartedMariaDbContainer | undefined;
  afterAll(async () => {
    await my?.stop();
    await ma?.stop();
  });

  it("mysql 8.0", async () => {
    my = await new MySqlContainer("mysql:8.0").withDatabase("testdb").withUsername("testuser").withUserPassword("testpass").start();
    const conn = await mysql.createConnection({ host: my.getHost(), port: my.getPort(), user: "testuser", password: "testpass", database: "testdb" });
    await probe("mysql8.0", (sql) => conn.query(sql));
    await conn.end();
  }, 300_000);

  it("mariadb 10.11", async () => {
    ma = await new MariaDbContainer("mariadb:10.11").withDatabase("testdb").withUsername("testuser").withUserPassword("testpass").start();
    const conn = await mariadb.createConnection({ host: ma.getHost(), port: ma.getPort(), user: "testuser", password: "testpass", database: "testdb" });
    await probe("mariadb10.11", (sql) => conn.query(sql));
    await conn.end();
  }, 300_000);
});
