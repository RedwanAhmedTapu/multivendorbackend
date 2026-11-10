// utils/barcode.ts
//
// Generates EAN-13 compatible barcode numbers for product variants so they
// can be printed as a standard 1D barcode (jsbarcode / any label printer
// can render "EAN13" format directly from this string) and scanned back
// at POS.
//
// We don't have a registered GS1 prefix, so we use "200" — the range
// 200-299 is reserved by GS1 for internal / in-store use, which is exactly
// this use case (vendor-internal product identification, not retail
// resale barcodes).

const INTERNAL_PREFIX = "200";

/** Computes the EAN-13 check digit for the first 12 digits. */
function ean13CheckDigit(digits12: string): number {
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    const d = Number(digits12[i]);
    sum += i % 2 === 0 ? d : d * 3;
  }
  return (10 - (sum % 10)) % 10;
}

/**
 * Generates a unique-enough 13-digit EAN-13 barcode string.
 * Format: [200][9-digit random/time-based body][check digit]
 * Uniqueness within a store is guaranteed at the DB layer (barcode is a
 * unique column) — call this in a small retry loop on create if a
 * collision is somehow reported.
 */
export function generateEan13Barcode(): string {
  const timePart = Date.now().toString().slice(-6); // last 6 digits of epoch ms
  const randPart = Math.floor(Math.random() * 1000)
    .toString()
    .padStart(3, "0");
  const body = `${timePart}${randPart}`; // 9 digits
  const digits12 = `${INTERNAL_PREFIX}${body}`;
  const check = ean13CheckDigit(digits12);
  return `${digits12}${check}`;
}

/** Basic shape check before hitting the DB (13 numeric digits, valid check digit). */
export function isValidEan13(code: string): boolean {
  if (!/^\d{13}$/.test(code)) return false;
  return ean13CheckDigit(code.slice(0, 12)) === Number(code[12]);
}