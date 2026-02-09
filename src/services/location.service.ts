import { prisma } from "../config/prisma.ts";
import * as XLSX from "xlsx";
import Papa from "papaparse";

type LocationLevel = "DIVISION" | "DISTRICT" | "THANA";

export const LocationService = {
  /**
   * Get all locations with full hierarchy (tree structure)
   */
  async getAll() {
    const rootLocations = await prisma.locations.findMany({
      where: { parent_id: null },
      orderBy: { sort_order: 'asc' },
    });

    const buildTree = async (location: any): Promise<any> => {
      const children = await prisma.locations.findMany({
        where: { parent_id: location.id },
        orderBy: { sort_order: 'asc' },
      });

      return {
        ...location,
        children: await Promise.all(children.map(buildTree)),
      };
    };

    return await Promise.all(rootLocations.map(buildTree));
  },

  /**
   * Get locations by level (DIVISION, DISTRICT, THANA)
   */
  async getByLevel(level: LocationLevel, parentId?: string) {
    const where: any = { level };
    if (parentId) {
      where.parent_id = parentId;
    }

    return prisma.locations.findMany({
      where,
      include: {
        locations: true, // parent relation
      },
      orderBy: { sort_order: 'asc' },
    });
  },

  /**
   * Get children of a specific location by parent ID
   */
  async getChildren(parentId: string) {
    return prisma.locations.findMany({
      where: { parent_id: parentId },
      orderBy: { sort_order: 'asc' },
    });
  },

  /**
   * Get location by ID with full hierarchy (children + ancestors)
   */
  async getById(id: string) {
    const location = await prisma.locations.findUnique({
      where: { id },
      include: {
        locations: true, // parent relation
      },
    });

    if (!location) return null;

    // Get all children recursively
    const buildTree = async (loc: any): Promise<any> => {
      const children = await prisma.locations.findMany({
        where: { parent_id: loc.id },
        orderBy: { sort_order: 'asc' },
      });

      return {
        ...loc,
        children: await Promise.all(children.map(buildTree)),
      };
    };

    // Get all ancestors
    const getAncestors = async (loc: any): Promise<any[]> => {
      if (!loc.locations) return [];
      const parent = await prisma.locations.findUnique({
        where: { id: loc.locations.id },
        include: { locations: true },
      });
      if (!parent) return [loc.locations];
      return [...await getAncestors(parent), loc.locations];
    };

    const [treeData, ancestors] = await Promise.all([
      buildTree(location),
      getAncestors(location),
    ]);

    return {
      ...treeData,
      ancestors,
    };
  },

  /**
   * Get all divisions (root level)
   */
  async getDivisions() {
    return prisma.locations.findMany({
      where: { level: 'DIVISION', parent_id: null },
      orderBy: { sort_order: 'asc' },
    });
  },

  /**
   * Get districts by division
   * If divisionId is provided, return only districts under that division
   * Otherwise, return all districts
   */
  async getDistricts(divisionId?: string) {
    const where: any = { level: 'DISTRICT' };
    if (divisionId) {
      where.parent_id = divisionId;
    }
    return prisma.locations.findMany({
      where,
      include: { locations: true }, // parent
      orderBy: { sort_order: 'asc' },
    });
  },

  /**
   * Get thanas by district
   * If districtId is provided, return only thanas under that district
   * Otherwise, return all thanas
   */
  async getThanas(districtId?: string) {
    const where: any = { level: 'THANA' };
    if (districtId) {
      where.parent_id = districtId;
    }
    return prisma.locations.findMany({
      where,
      include: { locations: true }, // parent
      orderBy: { sort_order: 'asc' },
    });
  },

  /**
   * Create a new location
   */
  async create(data: {
    name: string;
    nameLocal?: string;
    level: LocationLevel;
    parentId?: string;
    externalCode?: string;
    isCodSupported?: boolean;
    isDgCodSupported?: boolean;
    sortOrder?: number;
  }) {
    // Check if parent exists (if parentId provided)
    if (data.parentId) {
      const parent = await prisma.locations.findUnique({
        where: { id: data.parentId },
      });
      if (!parent) {
        throw new Error("Parent location not found");
      }
    }

    // Check if there are any children
    const children = await prisma.locations.findMany({
      where: { parent_id: data.parentId || null },
    });

    const isLeaf = children.length === 0;

    const newLocation = await prisma.locations.create({
      data: {
        name: data.name,
        name_local: data.nameLocal,
        level: data.level,
        parent_id: data.parentId || null,
        external_code: data.externalCode,
        is_cod_supported: data.isCodSupported,
        is_dg_cod_supported: data.isDgCodSupported,
        is_leaf_node: isLeaf,
        sort_order: data.sortOrder || 0,
      },
      include: {
        locations: true, // parent
      },
    });

    // Update parent's leaf status if it exists
    if (data.parentId) {
      await this.updateLeafStatus(data.parentId);
    }

    return newLocation;
  },

  /**
   * Update location
   */
  async update(id: string, data: {
    name?: string;
    nameLocal?: string;
    parentId?: string;
    externalCode?: string;
    isCodSupported?: boolean;
    isDgCodSupported?: boolean;
    sortOrder?: number;
  }) {
    // Check if new parent exists (if parentId changed)
    if (data.parentId !== undefined && data.parentId !== null) {
      const parent = await prisma.locations.findUnique({
        where: { id: data.parentId },
      });
      if (!parent) {
        throw new Error("Parent location not found");
      }
    }

    const updateData: any = {};
    if (data.name !== undefined) updateData.name = data.name;
    if (data.nameLocal !== undefined) updateData.name_local = data.nameLocal;
    if (data.parentId !== undefined) updateData.parent_id = data.parentId;
    if (data.externalCode !== undefined) updateData.external_code = data.externalCode;
    if (data.isCodSupported !== undefined) updateData.is_cod_supported = data.isCodSupported;
    if (data.isDgCodSupported !== undefined) updateData.is_dg_cod_supported = data.isDgCodSupported;
    if (data.sortOrder !== undefined) updateData.sort_order = data.sortOrder;

    const updatedLocation = await prisma.locations.update({
      where: { id },
      data: updateData,
      include: {
        locations: true, // parent
      },
    });

    // Update leaf status if needed
    if (data.parentId !== undefined) {
      await this.updateLeafStatus(id);
      if (data.parentId) {
        await this.updateLeafStatus(data.parentId);
      }
    }

    return updatedLocation;
  },

  /**
   * Update leaf node status for a location and its ancestors
   */
  async updateLeafStatus(locationId: string) {
    const location = await prisma.locations.findUnique({
      where: { id: locationId },
    });

    if (!location) return;

    const children = await prisma.locations.findMany({
      where: { parent_id: locationId },
    });

    const isLeaf = children.length === 0;

    await prisma.locations.update({
      where: { id: locationId },
      data: { is_leaf_node: isLeaf },
    });

    // Update parent if exists
    if (location.parent_id) {
      await this.updateLeafStatus(location.parent_id);
    }
  },

  /**
   * Delete location (only if no children)
   */
  async remove(id: string) {
    const children = await prisma.locations.findMany({
      where: { parent_id: id },
    });

    if (children.length > 0) {
      throw new Error("Cannot delete location with children");
    }

    const location = await prisma.locations.delete({
      where: { id },
    });

    // Update parent's leaf status if exists
    if (location.parent_id) {
      await this.updateLeafStatus(location.parent_id);
    }

    return location;
  },

  /**
   * Bulk upload locations from CSV/Excel
   * Expected columns: Division, District, Thana, DivisionCode, DistrictCode, ThanaCode
   */
  async bulkUpload(file: File) {
    const fileType = file.name.split('.').pop()?.toLowerCase();
    let data: any[] = [];

    if (fileType === 'csv') {
      const text = await file.text();
      const parsed = Papa.parse(text, {
        header: true,
        skipEmptyLines: true,
        dynamicTyping: true,
      });
      data = parsed.data;
    } else if (fileType === 'xlsx' || fileType === 'xls') {
      const buffer = await file.arrayBuffer();
      const workbook = XLSX.read(buffer, { type: 'array' });
      const sheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[sheetName];
      data = XLSX.utils.sheet_to_json(worksheet);
    } else {
      throw new Error("Unsupported file format. Use CSV or Excel files.");
    }

    const results = {
      divisions: { created: 0, updated: 0 },
      districts: { created: 0, updated: 0 },
      thanas: { created: 0, updated: 0 },
      errors: [] as Array<{ row: number; message: string }>,
    };

    const divisionMap = new Map<string, string>();
    const districtMap = new Map<string, string>();

    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      try {
        const divisionName = row.Division?.trim();
        const districtName = row.District?.trim();
        const thanaName = row.Thana?.trim();

        if (!divisionName || !districtName || !thanaName) {
          results.errors.push({
            row: i + 2,
            message: 'Missing required fields (Division, District, or Thana)',
          });
          continue;
        }

        // Find or create division
        let divisionId = divisionMap.get(divisionName);
        if (!divisionId) {
          let division = await prisma.locations.findFirst({
            where: { name: divisionName, level: 'DIVISION' },
          });

          if (!division) {
            division = await prisma.locations.create({
              data: {
                name: divisionName,
                level: 'DIVISION',
                external_code: row.DivisionCode || null,
                is_leaf_node: false,
                sort_order: results.divisions.created,
              },
            });
            results.divisions.created++;
          } else {
            results.divisions.updated++;
          }
          divisionId = division.id;
          divisionMap.set(divisionName, divisionId);
        }

        // Find or create district
        const districtKey = `${divisionName}:${districtName}`;
        let districtId = districtMap.get(districtKey);
        if (!districtId) {
          let district = await prisma.locations.findFirst({
            where: {
              name: districtName,
              level: 'DISTRICT',
              parent_id: divisionId,
            },
          });

          if (!district) {
            district = await prisma.locations.create({
              data: {
                name: districtName,
                level: 'DISTRICT',
                parent_id: divisionId,
                external_code: row.DistrictCode || null,
                is_leaf_node: false,
                sort_order: results.districts.created,
              },
            });
            results.districts.created++;
          } else {
            results.districts.updated++;
          }
          districtId = district.id;
          districtMap.set(districtKey, districtId);
        }

        // Create or update thana
        const existingThana = await prisma.locations.findFirst({
          where: {
            name: thanaName,
            level: 'THANA',
            parent_id: districtId,
          },
        });

        if (!existingThana) {
          await prisma.locations.create({
            data: {
              name: thanaName,
              level: 'THANA',
              parent_id: districtId,
              external_code: row.ThanaCode || null,
              is_cod_supported: row.IsCodSupported ?? true,
              is_dg_cod_supported: row.IsDgCodSupported ?? false,
              is_leaf_node: true,
              sort_order: results.thanas.created,
            },
          });
          results.thanas.created++;
        } else {
          results.thanas.updated++;
        }
      } catch (error: any) {
        results.errors.push({
          row: i + 2,
          message: error.message,
        });
      }
    }

    // Update leaf status for all affected locations
    for (const divisionId of divisionMap.values()) {
      await this.updateLeafStatus(divisionId);
    }

    return results;
  },

  /**
   * Search locations by name
   */
  async search(query: string, level?: LocationLevel) {
    const where: any = {
      OR: [
        { name: { contains: query, mode: 'insensitive' } },
        { name_local: { contains: query, mode: 'insensitive' } },
        { external_code: { contains: query, mode: 'insensitive' } },
      ],
    };

    if (level) {
      where.level = level;
    }

    return prisma.locations.findMany({
      where,
      include: {
        locations: true, // parent
      },
      orderBy: [
        { level: 'asc' },
        { sort_order: 'asc' },
      ],
    });
  },

  /**
   * Get leaf locations (locations with no children)
   */
  async getLeafLocations(level?: LocationLevel) {
    const where: any = { is_leaf_node: true };
    if (level) {
      where.level = level;
    }

    return prisma.locations.findMany({
      where,
      include: {
        locations: true, // parent
      },
      orderBy: { sort_order: 'asc' },
    });
  },

  /**
   * Get COD-supported locations
   */
  async getCodLocations(includeDgCod: boolean = false) {
    const where: any = {
      is_cod_supported: true,
    };

    if (includeDgCod) {
      where.is_dg_cod_supported = true;
    }

    return prisma.locations.findMany({
      where,
      include: {
        locations: true, // parent
      },
      orderBy: { sort_order: 'asc' },
    });
  },
};