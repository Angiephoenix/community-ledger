import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, chownSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import pg from 'pg';
import type { TestProject } from 'vitest/node';

// Starts a throwaway PostgreSQL 16 cluster, then builds a template database:
// Supabase test shim -> every migration in order -> seed. Each test file
// clones the template, so every file starts from the same fresh state.

const PG_BIN = process.env.PG_BIN ?? '/usr/lib/postgresql/16/bin';
const ROOT = resolve(__dirname, '../..');

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => res(port));
    });
    s.on('error', rej);
  });
}

function asPostgres(cmd: string, args: string[]) {
  // initdb refuses to run as root; use the postgres OS user when we are root.
  if (process.getuid?.() === 0) return execFileSync('runuser', ['-u', 'postgres', '--', join(PG_BIN, cmd), ...args], { stdio: 'pipe' });
  return execFileSync(join(PG_BIN, cmd), args, { stdio: 'pipe' });
}

export default async function setup(project: TestProject) {
  const dir = mkdtempSync(join(tmpdir(), 'cl-pg-'));
  if (process.getuid?.() === 0) chownSync(dir, Number(execFileSync('id', ['-u', 'postgres']).toString().trim()), Number(execFileSync('id', ['-g', 'postgres']).toString().trim()));
  const port = await freePort();
  asPostgres('initdb', ['-D', join(dir, 'data'), '-A', 'trust', '-U', 'postgres', '--no-sync']);
  asPostgres('pg_ctl', ['-D', join(dir, 'data'), '-o', `-p ${port} -k ${dir} -c listen_addresses=127.0.0.1 -c fsync=off -c max_connections=200`, '-l', join(dir, 'log'), '-w', 'start']);

  const admin = new pg.Client({ host: '127.0.0.1', port, user: 'postgres', database: 'postgres' });
  await admin.connect();
  await admin.query('create database cl_template');
  await admin.end();

  const db = new pg.Client({ host: '127.0.0.1', port, user: 'postgres', database: 'cl_template' });
  await db.connect();
  const applied: string[] = [];
  await db.query(readFileSync(join(ROOT, 'tests/db/supabase-shim.sql'), 'utf8'));
  for (const file of readdirSync(join(ROOT, 'supabase/migrations')).filter((f) => f.endsWith('.sql')).sort()) {
    try {
      await db.query(readFileSync(join(ROOT, 'supabase/migrations', file), 'utf8'));
    } catch (e) {
      throw new Error(`Migration ${file} failed: ${(e as Error).message}`);
    }
    applied.push(file);
  }
  try {
    await db.query(readFileSync(join(ROOT, 'supabase/seed.sql'), 'utf8'));
  } catch (e) {
    throw new Error(`Seed failed: ${(e as Error).message}`);
  }
  await db.end();

  project.provide('pgPort', port);
  project.provide('migrations', applied);

  return async () => {
    try {
      asPostgres('pg_ctl', ['-D', join(dir, 'data'), '-m', 'immediate', 'stop']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

declare module 'vitest' {
  export interface ProvidedContext {
    pgPort: number;
    migrations: string[];
  }
}
