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
  isForVariant?: boolean;
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
            where: { isForVariant: true },
            include: {
              attribute: {
                include: {
                  values: true,
                },
              },
            },
          },
          specifications: {
            include: {
              specification: {
                include: {
                  options: true,
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
          description: 'Length of the package'
        },
        { 
          header: 'Package Width', 
          key: 'packageWidth', 
          width: 15, 
          type: 'NUMBER', 
          isRequired: true,
          description: 'Width of the package'
        },
        { 
          header: 'Package Height', 
          key: 'packageHeight', 
          width: 15, 
          type: 'NUMBER', 
          isRequired: true,
          description: 'Height of the package'
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
          description: 'Type of warranty offered'
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
          validation: { type: 'custom', formula: 'ISURL', error: 'Enter valid URLs separated by commas' },
        },
        {
          header: 'Video URLs',
          key: 'videoUrls',
          width: 50,
          type: 'TEXT',
          isRequired: false,
          description: 'Comma-separated list of video URLs for the product',
          validation: { type: 'custom', formula: 'ISURL', error: 'Enter valid URLs separated by commas' },
        },
      ];

      // Add attribute columns with variant toggle
      const attributeColumns: ColumnConfig[] = category.attributes.map(attr => ({
        header: attr.attribute.name,
        key: attr.attribute.slug,
        width: 20,
        type: attr.attribute.type,
        values: attr.attribute.type === 'SELECT' ? attr.attribute.values.map(v => v.value) : [],
        isRequired: attr.isRequired,
        isForVariant: attr.isForVariant,
        description: `Attribute: ${attr.attribute.name}. ${attr.isForVariant ? 'Used for variant differentiation' : 'Common for all variants'}`
      }));

      // Add specification columns with variant toggle
      const specificationColumns: ColumnConfig[] = category.specifications.map(spec => ({
        header: spec.specification.name,
        key: spec.specification.slug,
        width: 20,
        type: spec.specification.type,
        values: spec.specification.type === 'SELECT' ? spec.specification.options.map(o => o.value) : [],
        isRequired: spec.isRequired,
        isForVariant: spec.isForVariant,
        description: `Specification: ${spec.specification.name}. ${spec.isForVariant ? 'Used for variant differentiation' : 'Common for all variants'}`
      }));

      const columns = [...fixedColumns, ...attributeColumns, ...specificationColumns];
      
      // Set worksheet columns
      worksheet.columns = columns.map(col => ({
        header: col.header,
        key: col.key,
        width: col.width
      }));

      // Style header row
      const headerRow = worksheet.getRow(1);
      headerRow.font = { bold: true };
      headerRow.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFCCCCCC' },
      };
      headerRow.alignment = { vertical: 'middle', horizontal: 'center' };

      // Add data validation and tooltips
      columns.forEach((col, index) => {
        const column = worksheet.getColumn(index + 1);
        
        // Add data validation for all rows after header
        if (col.type === 'SELECT' && col.values && col.values.length > 0) {
          column.eachCell({ includeEmpty: true }, (cell, rowNumber) => {
            if (rowNumber > 1) {
              cell.dataValidation = {
                type: 'list',
                allowBlank: !col.isRequired,
                formulae: [`"${col.values!.join(',')}"`],
                errorTitle: 'Invalid Input',
                error: `Please select a value from: ${col.values!.join(', ')}`,
              };
            }
          });
        } else if (col.type === 'NUMBER') {
          column.eachCell({ includeEmpty: true }, (cell, rowNumber) => {
            if (rowNumber > 1) {
              cell.dataValidation = {
                type: 'decimal',
                allowBlank: !col.isRequired,
                operator: 'greaterThanOrEqual',
                formulae: [0],
                errorTitle: 'Invalid Number',
                error: 'Value must be a positive number',
              };
            }
          });
        } else if (col.type === 'BOOLEAN') {
          column.eachCell({ includeEmpty: true }, (cell, rowNumber) => {
            if (rowNumber > 1) {
              cell.dataValidation = {
                type: 'list',
                allowBlank: !col.isRequired,
                formulae: ['"true,false"'],
                errorTitle: 'Invalid Input',
                error: 'Please select true or false',
              };
            }
          });
        }

        // Add comments/tooltips for all cells in the column
        column.eachCell({ includeEmpty: true }, (cell, rowNumber) => {
          if (rowNumber === 1) {
            // Header tooltip
            cell.note = {
              texts: [{ text: col.description || `Field: ${col.header}\nType: ${col.type}\nRequired: ${col.isRequired ? 'Yes' : 'No'}` }],
              margins: {
                insetmode: 'custom',
                inset: [0.1, 0.1, 0.1, 0.1]
              }
            };
          } else if (col.validation?.type === 'custom' && col.validation.formula === 'ISURL') {
            // URL validation tooltip
            cell.note = {
              texts: [{ text: 'Enter valid URLs separated by commas (e.g., https://example.com/image.jpg)' }],
              margins: {
                insetmode: 'custom',
                inset: [0.1, 0.1, 0.1, 0.1]
              }
            };
          } else if (col.key === 'variantGroupNo') {
            // Variant group tooltip
            cell.note = {
              texts: [{ text: 'Same number = variants of same product\nEmpty = standalone product' }],
              margins: {
                insetmode: 'custom',
                inset: [0.1, 0.1, 0.1, 0.1]
              }
            };
          }
        });
      });

      // Create sample data
      const sampleStandaloneRow: { [key: string]: any } = {
        variantGroupNo: '',
        name: 'Sample Standalone Product',
        description: 'Sample description for standalone product',
        sku: 'SAMPLE001',
        price: 99.99,
        stock: 10,
        packageWeight: 1,
        packageWeightUnit: 'KG',
        packageLength: 30,
        packageWidth: 20,
        packageHeight: 5,
        dangerousGoods: 'NONE',
        warrantyDuration: 1,
        warrantyUnit: 'YEARS',
        warrantyType: 'Standard',
        warrantyPolicy: 'Sample warranty policy',
        imageUrls: 'https://example.com/image1.jpg,https://example.com/image2.jpg',
        videoUrls: 'https://example.com/video.mp4',
      };

      const sampleVariant1Row: { [key: string]: any } = {
        variantGroupNo: 1,
        name: 'Sample Product with Variants',
        description: 'Sample description for product with variants',
        sku: 'SAMPLE002',
        price: 89.99,
        stock: 5,
        packageWeight: 1,
        packageWeightUnit: 'KG',
        packageLength: 30,
        packageWidth: 20,
        packageHeight: 5,
        dangerousGoods: 'NONE',
        warrantyDuration: 1,
        warrantyUnit: 'YEARS',
        warrantyType: 'Standard',
        warrantyPolicy: 'Sample warranty policy',
        imageUrls: 'https://example.com/variant1.jpg',
        videoUrls: '',
      };

      const sampleVariant2Row: { [key: string]: any } = {
        variantGroupNo: 1,
        name: 'Sample Product with Variants',
        description: 'Sample description for product with variants',
        sku: 'SAMPLE003',
        price: 109.99,
        stock: 8,
        packageWeight: 1.2,
        packageWeightUnit: 'KG',
        packageLength: 32,
        packageWidth: 22,
        packageHeight: 6,
        dangerousGoods: 'NONE',
        warrantyDuration: 1,
        warrantyUnit: 'YEARS',
        warrantyType: 'Standard',
        warrantyPolicy: 'Sample warranty policy',
        imageUrls: 'https://example.com/variant2.jpg',
        videoUrls: '',
      };

      // Fill attribute and specification values for sample rows
      columns.forEach(col => {
        if (col.type === 'SELECT' && col.values && col.values.length > 0) {
          sampleStandaloneRow[col.key] = col.values[0];
          sampleVariant1Row[col.key] = col.values[0];
          sampleVariant2Row[col.key] = col.values.length > 1 ? col.values[1] : col.values[0];
        } else if (col.type === 'NUMBER' && !sampleStandaloneRow[col.key]) {
          sampleStandaloneRow[col.key] = 10;
          sampleVariant1Row[col.key] = 10;
          sampleVariant2Row[col.key] = 15;
        } else if (col.type === 'BOOLEAN' && !sampleStandaloneRow[col.key]) {
          sampleStandaloneRow[col.key] = 'true';
          sampleVariant1Row[col.key] = 'true';
          sampleVariant2Row[col.key] = 'false';
        } else if (col.type === 'TEXT' && !sampleStandaloneRow[col.key]) {
          sampleStandaloneRow[col.key] = `Sample ${col.header}`;
          sampleVariant1Row[col.key] = `Sample ${col.header} 1`;
          sampleVariant2Row[col.key] = `Sample ${col.header} 2`;
        }
      });

      // Add sample rows
      worksheet.addRow(sampleStandaloneRow);
      worksheet.addRow(sampleVariant1Row);
      worksheet.addRow(sampleVariant2Row);

      // Create instructions sheet
      const metaSheet = workbook.addWorksheet('Instructions');
      metaSheet.columns = [
        { header: 'Field', key: 'field', width: 25 },
        { header: 'Description', key: 'description', width: 60 },
        { header: 'Required', key: 'required', width: 10 },
        { header: 'Type', key: 'type', width: 15 },
        { header: 'Variant Specific', key: 'variantSpecific', width: 15 },
        { header: 'Example', key: 'example', width: 30 },
      ];
      
      const metaHeaderRow = metaSheet.getRow(1);
      metaHeaderRow.font = { bold: true };
      metaHeaderRow.fill = { 
        type: 'pattern', 
        pattern: 'solid', 
        fgColor: { argb: 'FFCCCCCC' } 
      };

      // Add field descriptions
      columns.forEach(col => {
        metaSheet.addRow({
          field: col.header,
          description: col.description || `Enter the ${col.header.toLowerCase()} for the product`,
          required: col.isRequired ? 'Yes' : 'No',
          type: col.type,
          variantSpecific: col.isForVariant ? 'Yes' : 'No',
          example: col.values?.[0] || 
                   (col.type === 'NUMBER' ? '10' : 
                    col.type === 'BOOLEAN' ? 'true' : 
                    `Sample ${col.header}`),
        });
      });

      // Add general instructions
      metaSheet.addRow([]);
      metaSheet.addRow([
        'VARIANT INSTRUCTIONS',
        'Products with the same Variant Group No are variants of the same product. Leave Variant Group No empty for standalone products.',
        '', '', '', ''
      ]);
      metaSheet.addRow([
        'ATTRIBUTES & SPECIFICATIONS',
        'Fields marked as "Variant Specific: Yes" should have different values for each variant in a group.',
        '', '', '', ''
      ]);
      metaSheet.addRow([
        'REQUIRED FIELDS',
        'All required fields must be filled. SKU must be unique for each product/variant.',
        '', '', '', ''
      ]);
      metaSheet.addRow([
        'IMAGES & VIDEOS',
        'Enter comma-separated URLs. Ensure all URLs are accessible and point to valid media files.',
        '', '', '', ''
      ]);

      // Style the instructions sheet
      metaSheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return; // Skip header
        
        if (row.getCell(1).value === 'VARIANT INSTRUCTIONS' || 
            row.getCell(1).value === 'ATTRIBUTES & SPECIFICATIONS' ||
            row.getCell(1).value === 'REQUIRED FIELDS' ||
            row.getCell(1).value === 'IMAGES & VIDEOS') {
          row.font = { bold: true, color: { argb: 'FF0000FF' } };
          row.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFFFFFCC' }
          };
        }
      });

      // Ensure templates directory exists
      const fs = await import('fs');
      const templatesDir = join(__dirname, '..', 'templates');
      if (!fs.existsSync(templatesDir)) {
        fs.mkdirSync(templatesDir, { recursive: true });
      }

      // Save file
      const fileName = `${category.name.replace(/\s+/g, '_')}_Product_Template.xlsx`;
      const filePath = join(templatesDir, fileName);
      await workbook.xlsx.writeFile(filePath);

      // Save template record
      const templateRecord = await prisma.categoryTemplate.upsert({
        where: { categoryId },
        update: { filePath, updatedAt: new Date() },
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