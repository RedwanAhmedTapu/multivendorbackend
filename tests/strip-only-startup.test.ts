// tests/strip-only-startup.test.ts
//
// `npm run dev` (nodemon --exec "npx ts-node") and `npx ts-node src/server.ts`
// do NOT transform this ESM ("type": "module") project: ts-node 10 only hooks
// CommonJS, so Node 22.18+ loads src/*.ts through its own type STRIPPING. That
// mode rejects TypeScript-only runtime syntax — parameter properties
// (`constructor(readonly x: T)`), enums, namespaces — and the server then dies
// at startup with ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX (it happened twice).
//
// This test walks the static import graph from src/server.ts and runs Node's
// own stripper (node:module stripTypeScriptTypes) over every reachable file.
// No module is executed; nothing touches a database or the network.
//   npx tsx --test tests/strip-only-startup.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as nodeModule from "node:module";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");
const strip = (nodeModule as any).stripTypeScriptTypes as ((code: string, opts?: object) => string) | undefined;

const SPECIFIERS = [
  /\bimport\s+(?:type\s+)?[^'"]*?\sfrom\s*['"]([^'"]+)['"]/g,
  /\bexport\s+(?:type\s+)?[^'"]*?\sfrom\s*['"]([^'"]+)['"]/g,
  /\bimport\s*['"]([^'"]+)['"]/g,
  /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
];

function resolveLocal(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith(".")) base = resolve(dirname(from), spec);
  else if (spec.startsWith("@/")) base = join(SRC, spec.slice(2)); // tsconfig paths: "@/*" → src/*
  else return null; // a package
  for (const candidate of [base, `${base}.ts`, join(base, "index.ts")]) {
    if (candidate.endsWith(".ts") && existsSync(candidate)) return candidate;
  }
  return null;
}

function reachableFromServer(): string[] {
  const seen = new Set<string>();
  const queue = [join(SRC, "server.ts")];
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const code = readFileSync(file, "utf8");
    for (const re of SPECIFIERS) {
      for (const m of code.matchAll(re)) {
        if (/^\s*import\s+type\b|^\s*export\s+type\b/.test(m[0])) continue; // erased, never loaded
        const next = resolveLocal(file, m[1]);
        if (next && !seen.has(next)) queue.push(next);
      }
    }
  }
  return [...seen];
}

test("every module reachable from src/server.ts loads under Node's strip-only TypeScript", { skip: !strip && "node:module stripTypeScriptTypes unavailable" }, () => {
  const files = reachableFromServer();
  assert.ok(files.length > 50, `import graph too small (${files.length}) — the walker is broken`);
  const failures: string[] = [];
  for (const f of files) {
    try {
      strip!(readFileSync(f, "utf8"), { mode: "strip" });
    } catch (err: any) {
      failures.push(`${f.slice(ROOT.length + 1).replace(/\\/g, "/")}: ${String(err?.message ?? err).split("\n")[0]}`);
    }
  }
  assert.deepEqual(failures, [], "use explicit fields instead of parameter properties, and const objects instead of enums");
});

test("the three error classes keep their public fields (strip-safe rewrite)", async () => {
  const { CheckoutChangedError } = await import("../src/services/order.service.ts");
  const { OrderStatusTransitionError } = await import("../src/services/admin.order.service.ts");
  const { DeliveryFeeError } = await import("../src/services/payment.service.ts");
  const quote = { quoteHash: "h" } as any;
  const c = new CheckoutChangedError("PRICE_ACK_REQUIRED", quote);
  assert.deepEqual([c.code, c.reason, c.quote, c.name, c instanceof Error], ["CHECKOUT_CHANGED", "PRICE_ACK_REQUIRED", quote, "CheckoutChangedError", true]);
  assert.match(c.message, /accept the updated prices/);
  const o = new OrderStatusTransitionError(409, "changed");
  assert.deepEqual([o.code, o.statusCode, o.message, o.name], ["STATUS_TRANSITION_NOT_ALLOWED", 409, "changed", "OrderStatusTransitionError"]);
  const d = new DeliveryFeeError(404, "Order not found");
  assert.deepEqual([d.code, d.statusCode, d.message, d.name], ["DELIVERY_FEE_REFUSED", 404, "Order not found", "DeliveryFeeError"]);
});
