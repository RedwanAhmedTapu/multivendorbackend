import { PrismaClient } from '@prisma/client';
import ExcelJS from 'exceljs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

export interface ColumnConfig {
  header: string;
  key: string;
  width: number;
  type: 'TEXT' | 'NUMBER' | 'BOOLEAN' | 'SELECT';
  isRequired: boolean;
  values?: string[];
  validation?: {
    type: string;
    formula: string;
    error: string;
  };
  description?: string;
}

export interface TemplateResponse {
  filePath: string;
  templateRecord: {
    id: string;
    categoryId: string;
    filePath: string;
    createdAt: Date;
    updatedAt: Date;
  };
}

const prisma = new PrismaClient();

// Derive __dirname equivalent for ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export class TemplateService {
  async getCategoryTemplateData(categoryId: string) {
    try {
      const category = await prisma.category.findUnique({
        where: { id: categoryId },
        include: {
          attributes: {
            // REMOVED: where: { isForVariant: true }
            // This field doesn't exist on CategoryAttribute
            include: {
              attribute: {
                include: {
                  values: true,
                },
              },
            },
          },
          children: true,
        },
      });
      
      if (!category) throw new Error(`Category with ID ${categoryId} not found`);
      if (category.children && category.children.length > 0) {
        throw new Error('Selected category is not a leaf category');
      }
      return category;
    } catch (error) {
      console.error('Error fetching category data:', error);
      throw error;
    }
  }

  async generateExcelTemplate(categoryId: string): Promise<TemplateResponse> {
    try {
      const category = await this.getCategoryTemplateData(categoryId);
      const workbook = new ExcelJS.Workbook();
      workbook.creator = 'System';
      workbook.created = new Date();
      const worksheet = workbook.addWorksheet(`${category.name} Products`);

      const fixedColumns: ColumnConfig[] = [
        { 
          header: 'Variant Group No', 
          key: 'variantGroupNo', 
          width: 20, 
          type: 'NUMBER', 
          isRequired: false,
          description: 'Same number for products that are variants of each other. Leave empty for standalone products.'
        },
        { 
          header: 'Product Name', 
          key: 'name', 
          width: 30, 
          type: 'TEXT', 
          isRequired: true,
          description: 'Name of the product. Same for all variants in a group.'
        },
        { 
          header: 'Description', 
          key: 'description', 
          width: 50, 
          type: 'TEXT', 
          isRequired: false,
          description: 'Product description. Same for all variants in a group.'
        },
        { 
          header: 'SKU', 
          key: 'sku', 
          width: 20, 
          type: 'TEXT', 
          isRequired: true,
          description: 'Unique stock keeping unit. Must be unique for each variant.'
        },
        { 
          header: 'Price', 
          key: 'price', 
          width: 15, 
          type: 'NUMBER', 
          isRequired: true,
          description: 'Product price in local currency'
        },
        { 
          header: 'Stock', 
          key: 'stock', 
          width: 10, 
          type: 'NUMBER', 
          isRequired: true,
          description: 'Available quantity in stock'
        },
        { 
          header: 'Package Weight', 
          key: 'packageWeight', 
          width: 15, 
          type: 'NUMBER', 
          isRequired: true,
          description: 'Weight of the product package'
        },
        {
          header: 'Package Weight Unit',
          key: 'packageWeightUnit',
          width: 20,
          type: 'SELECT',
          values: ['KG', 'G'],
          isRequired: true,
          description: 'Unit of measurement for package weight'
        },
        { 
          header: 'Package Length', 
          key: 'packageLength', 
          width: 15, 
          type: 'NUMBER', 
          isRequired: true,
          description: 'Length of the package (cm)'
        },
        { 
          header: 'Package Width', 
          key: 'packageWidth', 
          width: 15, 
          type: 'NUMBER', 
          isRequired: true,
          description: 'Width of the package (cm)'
        },
        { 
          header: 'Package Height', 
          key: 'packageHeight', 
          width: 15, 
          type: 'NUMBER', 
          isRequired: true,
          description: 'Height of the package (cm)'
        },
        {
          header: 'Dangerous Goods',
          key: 'dangerousGoods',
          width: 20,
          type: 'SELECT',
          values: ['NONE', 'CONTAINS'],
          isRequired: true,
          description: 'Indicates if product contains dangerous goods'
        },
        { 
          header: 'Warranty Duration', 
          key: 'warrantyDuration', 
          width: 15, 
          type: 'NUMBER', 
          isRequired: false,
          description: 'Duration of warranty'
        },
        {
          header: 'Warranty Unit',
          key: 'warrantyUnit',
          width: 20,
          type: 'SELECT',
          values: ['DAYS', 'MONTHS', 'YEARS'],
          isRequired: false,
          description: 'Unit of time for warranty duration'
        },
        { 
          header: 'Warranty Type', 
          key: 'warrantyType', 
          width: 20, 
          type: 'TEXT', 
          isRequired: false,
          description: 'Type of warranty offered (e.g., Manufacturer, Seller)'
        },
        { 
          header: 'Warranty Policy', 
          key: 'warrantyPolicy', 
          width: 50, 
          type: 'TEXT', 
          isRequired: false,
          description: 'Detailed warranty policy information'
        },
        {
          header: 'Image URLs',
          key: 'imageUrls',
          width: 50,
          type: 'TEXT',
          isRequired: false,
          description: 'Comma-separated list of image URLs for the product',
        },
        {
          header: 'Video URL',
          key: 'videoUrl',
          width: 50,
          type: 'TEXT',
          isRequired: false,
          description: 'Video URL for the product',
        },
      ];

      // Add attribute columns
      const attributeColumns: ColumnConfig[] = category.attributes.map(attr => ({
        header: attr.attribute.name,
        key: attr.attribute.slug,
        width: 20,
        type: attr.attribute.type,
        values: attr.attribute.type === 'SELECT' ? attr.attribute.values.map(v => v.value) : [],
        isRequired: attr.isRequired,
        description: `${attr.attribute.name}${attr.attribute.unit ? ` (${attr.attribute.unit})` : ''}. ${attr.isRequired ? 'Required' : 'Optional'} field.`
      }));

      const columns = [...fixedColumns, ...attributeColumns];
      
      // Set worksheet columns
      worksheet.columns = columns.map(col => ({
        header: col.header,
        key: col.key,
        width: col.width
      }));

      // Style header row
      const headerRow = worksheet.getRow(1);
      headerRow.font = { bold: true, size: 11 };
      headerRow.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FF4472C4' },
      };
      headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      headerRow.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
      headerRow.height = 30;

      // Add data validation and notes
      columns.forEach((col, index) => {
        const column = worksheet.getColumn(index + 1);
        
        // Add data validation for all rows after header
        if (col.type === 'SELECT' && col.values && col.values.length > 0) {
          // Apply validation to first 1000 rows
          for (let rowNum = 2; rowNum <= 1001; rowNum++) {
            const cell = worksheet.getCell(rowNum, index + 1);
            cell.dataValidation = {
              type: 'list',
              allowBlank: !col.isRequired,
              formulae: [`"${col.values!.join(',')}"`],
              showErrorMessage: true,
              errorStyle: 'error',
              errorTitle: 'Invalid Input',
              error: `Please select from: ${col.values!.join(', ')}`,
            };
          }
        } else if (col.type === 'NUMBER') {
          for (let rowNum = 2; rowNum <= 1001; rowNum++) {
            const cell = worksheet.getCell(rowNum, index + 1);
            cell.dataValidation = {
              type: 'decimal',
              allowBlank: !col.isRequired,
              operator: 'greaterThanOrEqual',
              formulae: [0],
              showErrorMessage: true,
              errorStyle: 'error',
              errorTitle: 'Invalid Number',
              error: 'Value must be 0 or greater',
            };
          }
        } else if (col.type === 'BOOLEAN') {
          for (let rowNum = 2; rowNum <= 1001; rowNum++) {
            const cell = worksheet.getCell(rowNum, index + 1);
            cell.dataValidation = {
              type: 'list',
              allowBlank: !col.isRequired,
              formulae: ['"true,false"'],
              showErrorMessage: true,
              errorStyle: 'error',
              errorTitle: 'Invalid Input',
              error: 'Please select true or false',
            };
          }
        }

        // Add header note/comment
        const headerCell = worksheet.getCell(1, index + 1);
        headerCell.note = {
          texts: [{
            text: `${col.description}\n\nType: ${col.type}\nRequired: ${col.isRequired ? 'Yes' : 'No'}${col.values ? `\nOptions: ${col.values.join(', ')}` : ''}`
          }],
          margins: {
            insetmode: 'custom',
            inset: [0.1, 0.1, 0.1, 0.1]
          }
        };
      });

      // Add sample data rows
      const sampleStandaloneRow: { [key: string]: any } = {
        variantGroupNo: '',
        name: 'Example Standalone Product',
        description: 'This is a standalone product without variants',
        sku: 'SKU-STANDALONE-001',
        price: 99.99,
        stock: 50,
        packageWeight: 1.5,
        packageWeightUnit: 'KG',
        packageLength: 30,
        packageWidth: 20,
        packageHeight: 10,
        dangerousGoods: 'NONE',
        warrantyDuration: 12,
        warrantyUnit: 'MONTHS',
        warrantyType: 'Manufacturer',
        warrantyPolicy: 'Standard manufacturer warranty covering defects',
        imageUrls: 'https://example.com/product1.jpg,https://example.com/product1-alt.jpg',
        videoUrl: 'https://example.com/product1-video.mp4',
      };

      const sampleVariant1Row: { [key: string]: any } = {
        variantGroupNo: 1,
        name: 'Example Product with Variants',
        description: 'This product has multiple color/size variants',
        sku: 'SKU-VAR1-RED-SMALL',
        price: 79.99,
        stock: 25,
        packageWeight: 1.2,
        packageWeightUnit: 'KG',
        packageLength: 28,
        packageWidth: 18,
        packageHeight: 8,
        dangerousGoods: 'NONE',
        warrantyDuration: 6,
        warrantyUnit: 'MONTHS',
        warrantyType: 'Seller',
        warrantyPolicy: 'Standard warranty',
        imageUrls: 'https://example.com/variant-red-small.jpg',
        videoUrl: '',
      };

      const sampleVariant2Row: { [key: string]: any } = {
        variantGroupNo: 1,
        name: 'Example Product with Variants',
        description: 'This product has multiple color/size variants',
        sku: 'SKU-VAR1-BLUE-LARGE',
        price: 89.99,
        stock: 30,
        packageWeight: 1.5,
        packageWeightUnit: 'KG',
        packageLength: 32,
        packageWidth: 22,
        packageHeight: 10,
        dangerousGoods: 'NONE',
        warrantyDuration: 6,
        warrantyUnit: 'MONTHS',
        warrantyType: 'Seller',
        warrantyPolicy: 'Standard warranty',
        imageUrls: 'https://example.com/variant-blue-large.jpg',
        videoUrl: '',
      };

      // Fill attribute values for sample rows
      attributeColumns.forEach(col => {
        if (col.type === 'SELECT' && col.values && col.values.length > 0) {
          sampleStandaloneRow[col.key] = col.values[0];
          sampleVariant1Row[col.key] = col.values[0];
          sampleVariant2Row[col.key] = col.values.length > 1 ? col.values[1] : col.values[0];
        } else if (col.type === 'NUMBER') {
          sampleStandaloneRow[col.key] = 100;
          sampleVariant1Row[col.key] = 50;
          sampleVariant2Row[col.key] = 75;
        } else if (col.type === 'BOOLEAN') {
          sampleStandaloneRow[col.key] = 'true';
          sampleVariant1Row[col.key] = 'true';
          sampleVariant2Row[col.key] = 'false';
        } else if (col.type === 'TEXT') {
          sampleStandaloneRow[col.key] = `Sample ${col.header}`;
          sampleVariant1Row[col.key] = `Sample ${col.header} Var1`;
          sampleVariant2Row[col.key] = `Sample ${col.header} Var2`;
        }
      });

      // Add sample rows with styling
      const row2 = worksheet.addRow(sampleStandaloneRow);
      const row3 = worksheet.addRow(sampleVariant1Row);
      const row4 = worksheet.addRow(sampleVariant2Row);

      // Style sample rows
      [row2, row3, row4].forEach(row => {
        row.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFF8F9FA' },
        };
        row.font = { color: { argb: 'FF6C757D' }, italic: true };
      });

      // Create instructions sheet
      const instructionsSheet = workbook.addWorksheet('📋 Instructions');
      instructionsSheet.columns = [
        { header: 'Field Name', key: 'field', width: 25 },
        { header: 'Description', key: 'description', width: 60 },
        { header: 'Required', key: 'required', width: 12 },
        { header: 'Data Type', key: 'type', width: 15 },
        { header: 'Example', key: 'example', width: 35 },
      ];
      
      // Style instructions header
      const instHeaderRow = instructionsSheet.getRow(1);
      instHeaderRow.font = { bold: true, size: 12, color: { argb: 'FFFFFFFF' } };
      instHeaderRow.fill = { 
        type: 'pattern', 
        pattern: 'solid', 
        fgColor: { argb: 'FF28A745' } 
      };
      instHeaderRow.alignment = { vertical: 'middle', horizontal: 'center' };
      instHeaderRow.height = 25;

      // Add field descriptions
      columns.forEach(col => {
        const exampleValue = col.values?.[0] || 
                           (col.type === 'NUMBER' ? (col.key.includes('price') ? '99.99' : '10') : 
                            col.type === 'BOOLEAN' ? 'true' : 
                            col.key === 'sku' ? 'SKU-ABC-123' :
                            col.key === 'variantGroupNo' ? '1 (or leave empty)' :
                            `Example ${col.header}`);
        
        instructionsSheet.addRow({
          field: col.header,
          description: col.description || `Enter the ${col.header.toLowerCase()} for the product`,
          required: col.isRequired ? '✓ Yes' : '○ No',
          type: col.type,
          example: exampleValue,
        });
      });

      // Add spacing and important notes
      instructionsSheet.addRow([]);
      instructionsSheet.addRow([]);
      
      const importantNotesRow = instructionsSheet.addRow([
        '⚠️ IMPORTANT NOTES',
        '', '', '', ''
      ]);
      importantNotesRow.font = { bold: true, size: 14, color: { argb: 'FFDC3545' } };
      importantNotesRow.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFFFF3CD' }
      };

      const notes = [
        {
          title: '1️⃣ Variant Groups',
          desc: 'Products with the same Variant Group No are variants of the same product (e.g., different sizes/colors). Leave empty for standalone products.'
        },
        {
          title: '2️⃣ SKU Requirements',
          desc: 'Each SKU must be unique across all products. Format: SKU-[PRODUCT]-[VARIANT] (e.g., SKU-TSHIRT-RED-M)'
        },
        {
          title: '3️⃣ Required Fields',
          desc: 'All fields marked with "✓ Yes" must be filled. Empty required fields will cause import errors.'
        },
        {
          title: '4️⃣ Image URLs',
          desc: 'Separate multiple URLs with commas. Ensure URLs are publicly accessible and point to valid images.'
        },
        {
          title: '5️⃣ Data Validation',
          desc: 'Dropdown fields show available options. Numbers must be positive. Follow the data type for each field.'
        },
      ];

      notes.forEach(note => {
        const noteRow = instructionsSheet.addRow([note.title, note.desc, '', '', '']);
        noteRow.font = { bold: true };
        noteRow.getCell(1).fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFE7F3FF' }
        };
        noteRow.alignment = { vertical: 'top', wrapText: true };
        noteRow.height = 40;
      });

      // Ensure templates directory exists
      const fs = await import('fs');
      const templatesDir = join(__dirname, '..', 'templates');
      if (!fs.existsSync(templatesDir)) {
        fs.mkdirSync(templatesDir, { recursive: true });
      }

      // Save file
      const fileName = `${category.name.replace(/[^a-zA-Z0-9]/g, '_')}_Product_Template_${Date.now()}.xlsx`;
      const filePath = join(templatesDir, fileName);
      await workbook.xlsx.writeFile(filePath);

      // Save template record
      const templateRecord = await prisma.categoryTemplate.upsert({
        where: { categoryId },
        update: { 
          filePath, 
          updatedAt: new Date() 
        },
        create: { 
          categoryId, 
          filePath, 
          createdAt: new Date(), 
          updatedAt: new Date() 
        },
      });

      return { filePath, templateRecord };
    } catch (error) {
      console.error('Error generating Excel template:', error);
      throw error;
    } finally {
      await prisma.$disconnect();
    }
  }
}