// src/modules/hrm/services/letterPdf.service.ts
//
// Renders an issued HrLetter's `content` into a downloadable PDF.
//
// Uses puppeteer (already a project dependency) to print a minimal HTML
// document to PDF. This also gives us correct rendering of Bengali text
// through the system fonts — pdfkit's built-in Helvetica cannot do that.

import puppeteer from "puppeteer";
import type { HrLetter } from "@prisma/client";

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export async function renderLetterPdf(letter: HrLetter, companyName = "FinixMart"): Promise<Buffer> {
  const date = (letter.issuedAt ?? letter.createdAt).toISOString().slice(0, 10);

  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  body {
    font-family: Arial, "Noto Sans Bengali", "SolaimanLipi", sans-serif;
    color: #000;
  }
  .company { font-size: 21px; font-weight: bold; text-align: center; }
  .letter-no { font-size: 13px; color: #555; text-align: center; }
  .date { font-size: 13px; text-align: right; margin-top: 36px; }
  .subject { font-size: 17px; font-weight: bold; margin-top: 24px; }
  .content { font-size: 14px; white-space: pre-wrap; line-height: 1.6; margin-top: 24px; }
  .signature { margin-top: 72px; font-size: 14px; }
</style>
</head>
<body>
  <div class="company">${escapeHtml(companyName)}</div>
  <div class="letter-no">Letter No: ${escapeHtml(letter.letterNumber)}</div>
  <div class="date">Date: ${escapeHtml(date)}</div>
  <div class="subject">${escapeHtml(letter.subject)}</div>
  <div class="content">${escapeHtml(letter.content)}</div>
  <div class="signature">_______________________<br />Authorized Signature</div>
</body>
</html>`;

  const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "load" });
    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "60px", bottom: "60px", left: "60px", right: "60px" },
    });
    return Buffer.from(pdf);
  } finally {
    await browser.close();
  }
}
