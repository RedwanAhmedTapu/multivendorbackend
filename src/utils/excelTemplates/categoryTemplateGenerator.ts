// src/utils/excelTemplates/categoryTemplateGenerator.ts
import pkg from "xlsx";
const { utils, write } = pkg; // Changed from writeFile to write

export interface TemplateOptions {
  maxLevels?: number;
  includeAttributes?: number;
  templateType?: 'standard' | 'custom';
}

export class CategoryTemplateGenerator {
  /**
   * Generate workbook for template
   */
  static generateWorkbook(options: TemplateOptions = {}) {
    const maxLevels = options.maxLevels || 5;
    const includeAttributes = options.includeAttributes || 3;
    
    // Build headers
    const categoryHeaders = Array.from({ length: maxLevels }, (_, i) => `Level ${i + 1}`);
    
    const headers = [
      ...categoryHeaders,
      "image",
      "keywords",
      "tags",
    ];

    // Add attribute headers
    for (let i = 1; i <= includeAttributes; i++) {
      headers.push(
        `attr_Example${i}`,
        `attr_Example${i}_type`,
        `attr_Example${i}_unit`,
        `attr_Example${i}_required`,
        `attr_Example${i}_filterable`,
        `attr_Example${i}_values`
      );
    }

    // Sample data
    const sampleData = options.templateType === 'standard' 
      ? this.getStandardSampleData(maxLevels, includeAttributes)
      : this.getCustomSampleData(maxLevels, includeAttributes);

    const data = [headers, ...sampleData];
    const ws = utils.aoa_to_sheet(data);
    const wb = utils.book_new();
    utils.book_append_sheet(wb, ws, "Categories");

    // Set column widths
    ws["!cols"] = [
      ...Array(maxLevels).fill({ wch: 20 }),
      { wch: 50 }, // image
      { wch: 40 }, // keywords
      { wch: 30 }, // tags
      ...Array(includeAttributes * 6).fill({ wch: 18 }), // Attributes
    ];

    return wb;
  }

  /**
   * Get standard sample data with multiple examples
   */
  private static getStandardSampleData(maxLevels: number, attributeCount: number) {
    const baseSamples = [
      // Electronics example
      [
        "Electronics", "Smartphones", "Android Phones", "", "",
        "https://example.com/electronics.jpg",
        "smartphone,android,mobile",
        "featured,bestseller",
        "Brand", "SELECT", "", "true", "true", "Samsung,OnePlus,Xiaomi",
        "Color", "SELECT", "", "true", "true", "Black,White,Blue",
        "Storage", "SELECT", "GB", "true", "true", "64,128,256",
      ],
      
      // Fashion example
      [
        "Fashion", "Men's Clothing", "Shirts", "Casual", "",
        "https://example.com/fashion.jpg",
        "shirt,casual,cotton",
        "summer,new-arrival",
        "Size", "SELECT", "", "true", "true", "S,M,L,XL",
        "Fit", "SELECT", "", "true", "true", "Slim,Regular",
        "Material", "TEXT", "", "false", "true", "",
      ],
      
      // Books example
      [
        "Books", "Fiction", "", "", "",
        "https://example.com/books.jpg",
        "books,fiction,reading",
        "bestseller,classic",
        "Author", "TEXT", "", "true", "true", "",
        "Genre", "SELECT", "", "true", "true", "Mystery,Romance,Sci-Fi",
        "Format", "SELECT", "", "false", "true", "Paperback,Hardcover",
      ],
    ];

    return baseSamples.map(row => this.adjustRowForLevels(row, maxLevels, attributeCount));
  }

  /**
   * Get custom sample data with dynamic levels
   */
  private static getCustomSampleData(maxLevels: number, attributeCount: number) {
    // Create a sample with dynamic levels
    const categoryValues = Array(maxLevels).fill("").map((_, i) => 
      i < 3 ? `Category Level ${i + 1}` : ""
    );
    
    const baseRow = [
      ...categoryValues,
      "https://example.com/image.jpg",
      "keyword1,keyword2,keyword3",
      "tag1,tag2",
    ];

    // Add attributes
    const attributes = [];
    for (let i = 1; i <= attributeCount; i++) {
      attributes.push(
        `Attribute${i}`,
        "SELECT",
        i === 3 ? "unit" : "",
        "true",
        "true",
        "Value1,Value2,Value3"
      );
    }

    return [this.adjustRowForLevels([...baseRow, ...attributes], maxLevels, attributeCount)];
  }

  /**
   * Adjust row to match exact column counts
   */
  private static adjustRowForLevels(row: any[], maxLevels: number, attributeCount: number): any[] {
    const adjustedRow = [...row];
    
    // Ensure we have exactly maxLevels category columns
    const categoryCols = adjustedRow.slice(0, 5);
    while (categoryCols.length < maxLevels) {
      categoryCols.push("");
    }
    while (categoryCols.length > maxLevels) {
      categoryCols.pop();
    }
    
    // Fixed columns: image, keywords, tags
    const fixedCols = adjustedRow.slice(5, 8);
    
    // Adjust attributes
    let attributes = adjustedRow.slice(8);
    const expectedAttrCols = attributeCount * 6;
    
    if (attributes.length > expectedAttrCols) {
      attributes = attributes.slice(0, expectedAttrCols);
    } else if (attributes.length < expectedAttrCols) {
      const needed = expectedAttrCols - attributes.length;
      for (let i = 0; i < needed; i++) {
        attributes.push("");
      }
    }
    
    return [...categoryCols, ...fixedCols, ...attributes];
  }

  /**
   * Generate workbook buffer for HTTP response
   * FIXED: Use 'write' instead of 'writeFile'
   */
  static generateWorkbookBuffer(options: TemplateOptions = {}): Buffer {
    try {
      const wb = this.generateWorkbook(options);
      
      // Use write() to generate buffer, not writeFile()
      const buffer = write(wb, { 
        type: 'buffer', 
        bookType: 'xlsx',
        compression: true // Optional: compress the file
      });
      
      return Buffer.from(buffer);
    } catch (error) {
      console.error('Error generating workbook buffer:', error);
      throw new Error(`Failed to generate Excel buffer: ${error.message}`);
    }
  }
}