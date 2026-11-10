// src/utils/excelTemplates/bankTemplateGenerator.ts
import ExcelJS from "exceljs";

export class BankTemplateGenerator {
  static async generateWorkbookBuffer(): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = "System";
    workbook.created = new Date();

    const sheet = workbook.addWorksheet("Branches");
    sheet.columns = [
      { header: "Bank Name *", key: "bankName", width: 32 },
      { header: "Branch Name *", key: "branchName", width: 28 },
      { header: "Routing Number", key: "routingNumber", width: 18 },
    ];

    const header = sheet.getRow(1);
    header.font = { bold: true, color: { argb: "FFFFFFFF" } };
    header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFC0392B" } };
    header.alignment = { vertical: "middle", horizontal: "center" };
    header.height = 26;

    // Sample rows (real data first, then a placeholder row showing the format)
    const samples = [
      {
        bankName: "Agrani Bank PLC",
        branchName: "BANDARBAN",
        routingNumber: "",
      },
      {
        bankName: "Agrani Bank PLC",
        branchName: "BRAHMANBARIA",
        routingNumber: "",
      },
      {
        bankName: "Pubali Bank PLC",
        branchName: "<BRANCH_NAME>",
        routingNumber: "<9_DIGIT_ROUTING_NUMBER>",
      },
    ];
    samples.forEach((s) => {
      const row = sheet.addRow(s);
      row.font = { italic: true, color: { argb: "FF888888" } };
    });

    sheet.views = [{ state: "frozen", xSplit: 0, ySplit: 1 }];

    const inst = workbook.addWorksheet("Instructions");
    inst.columns = [
      { header: "Column", key: "col", width: 20 },
      { header: "Required?", key: "req", width: 12 },
      { header: "Notes", key: "notes", width: 75 },
    ];
    inst.getRow(1).font = { bold: true };
    inst.addRow({
      col: "Bank Name",
      req: "YES",
      notes:
        "Exact bank name. If a bank with this name doesn't exist yet, it will be created automatically.",
    });
    inst.addRow({
      col: "Branch Name",
      req: "YES",
      notes: "Name of the branch. Must be unique within the same bank.",
    });
    inst.addRow({
      col: "Routing Number",
      req: "No",
      notes:
        "Bangladesh Bank routing number — exactly 9 digits when provided. Leave blank if not yet known; it can be added later.",
    });

    const buffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(buffer);
  }
}