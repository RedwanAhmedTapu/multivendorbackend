// src/services/warehouse.service.ts
import pkg, { type Prisma } from '@prisma/client';
const { PrismaClient, WarehouseType } = pkg;


const prisma = new PrismaClient();

interface CreateWarehouseInput {
  vendorId: string;
  locationId: string;
  code?: string;
  name?: string;
  address?: string;
  email?: string;
  phone?: string;
  isDefault?: boolean;
  type?: typeof WarehouseType[keyof typeof WarehouseType];
}

interface UpdateWarehouseInput {
  locationId?: string;
  code?: string;
  name?: string;
  address?: string;
  email?: string;
  phone?: string;
  isDefault?: boolean;
  type?: typeof WarehouseType[keyof typeof WarehouseType];
}

interface CreateHolidayInput {
  warehouseId: string;
  start: Date;
  end: Date;
  isOpen?: boolean;
}

interface UpdateHolidayInput {
  start?: Date;
  end?: Date;
  isOpen?: boolean;
}
interface BulkWarehouseInput {
  pickupWarehouse: {
    locationId: string;
    address: string;
    code?: string;
    name?: string;
    email?: string;
    phone?: string;
  };
  returnWarehouse?: {
    locationId: string;
    address: string;
    code?: string;
    name?: string;
    email?: string;
    phone?: string;
    sameAsPickup?: boolean;
  };
}
export class WarehouseService {

  async createOrUpdateBulkWarehouses(vendorId: string, data: BulkWarehouseInput) {
      // Verify vendor exists
      const vendor = await prisma.vendor.findUnique({
        where: { id: vendorId },
      });
  
      if (!vendor) {
        const error = new Error('Vendor not found');
        (error as any).statusCode = 404;
        throw error;
      }
  
      const result: any = {};
  
      // Handle PICKUP warehouse
      if (data.pickupWarehouse) {
        // Verify location exists
        const pickupLocation = await prisma.locations.findUnique({
          where: { id: data.pickupWarehouse.locationId },
        });
  
        if (!pickupLocation) {
          const error = new Error('Pickup location not found');
          (error as any).statusCode = 404;
          throw error;
        }
  
        // Check if pickup warehouse already exists
        const existingPickup = await prisma.vendorWarehouse.findFirst({
          where: {
            vendorId: vendorId,
            type: WarehouseType.PICKUP,
          },
        });
  
        if (existingPickup) {
          // Update existing pickup warehouse
          result.pickupWarehouse = await prisma.vendorWarehouse.update({
            where: { id: existingPickup.id },
            data: {
              locationId: data.pickupWarehouse.locationId,
              address: data.pickupWarehouse.address,
              code: data.pickupWarehouse.code,
              name: data.pickupWarehouse.name,
              email: data.pickupWarehouse.email,
              phone: data.pickupWarehouse.phone,
              isDefault: true,
            },
            include: {
              vendor: true,
              location: true,
            },
          });
        } else {
          // Create new pickup warehouse
          result.pickupWarehouse = await prisma.vendorWarehouse.create({
            data: {
              vendorId: vendorId,
              locationId: data.pickupWarehouse.locationId,
              address: data.pickupWarehouse.address,
              code: data.pickupWarehouse.code,
              name: data.pickupWarehouse.name,
              email: data.pickupWarehouse.email,
              phone: data.pickupWarehouse.phone,
              type: WarehouseType.PICKUP,
              isDefault: true,
            },
            include: {
              vendor: true,
              location: true,
            },
          });
        }
      }
  
      // Handle RETURN/RETURN warehouse
      if (data.returnWarehouse && !data.returnWarehouse.sameAsPickup) {
        // Verify location exists
        const returnLocation = await prisma.locations.findUnique({
          where: { id: data.returnWarehouse.locationId },
        });
  
        if (!returnLocation) {
          const error = new Error('Return location not found');
          (error as any).statusCode = 404;
          throw error;
        }
  
        // Check if return warehouse already exists
        const existingReturn = await prisma.vendorWarehouse.findFirst({
          where: {
            vendorId: vendorId,
            type: WarehouseType.RETURN,
          },
        });
  
        if (existingReturn) {
          // Update existing return warehouse
          result.returnWarehouse = await prisma.vendorWarehouse.update({
            where: { id: existingReturn.id },
            data: {
              locationId: data.returnWarehouse.locationId,
              address: data.returnWarehouse.address,
              code: data.returnWarehouse.code,
              name: data.returnWarehouse.name,
              email: data.returnWarehouse.email,
              phone: data.returnWarehouse.phone,
              isDefault: false,
            },
            include: {
              vendor: true,
              location: true,
            },
          });
        } else {
          // Create new return warehouse
          result.returnWarehouse = await prisma.vendorWarehouse.create({
            data: {
              vendorId: vendorId,
              locationId: data.returnWarehouse.locationId,
              address: data.returnWarehouse.address,
              code: data.returnWarehouse.code,
              name: data.returnWarehouse.name,
              email: data.returnWarehouse.email,
              phone: data.returnWarehouse.phone,
              type: WarehouseType.RETURN,
              isDefault: false,
            },
            include: {
              vendor: true,
              location: true,
            },
          });
        }
      } else if (data.returnWarehouse?.sameAsPickup) {
        // If return address is same as pickup, copy pickup warehouse data
        const existingReturn = await prisma.vendorWarehouse.findFirst({
          where: {
            vendorId: vendorId,
            type: WarehouseType.RETURN,
          },
        });
  
        const returnData = {
          locationId: data.pickupWarehouse!.locationId,
          address: data.pickupWarehouse!.address,
          code: data.pickupWarehouse?.code,
          name: data.pickupWarehouse?.name,
          email: data.pickupWarehouse?.email,
          phone: data.pickupWarehouse?.phone,
          isDefault: false,
        };
  
        if (existingReturn) {
          result.returnWarehouse = await prisma.vendorWarehouse.update({
            where: { id: existingReturn.id },
            data: returnData,
            include: {
              vendor: true,
              location: true,
            },
          });
        } else {
          result.returnWarehouse = await prisma.vendorWarehouse.create({
            data: {
              ...returnData,
              vendorId: vendorId,
              type: WarehouseType.RETURN,
            },
            include: {
              vendor: true,
              location: true,
            },
          });
        }
      }
  
      return result;
    }
  async createWarehouse(data: CreateWarehouseInput) {
    const vendor = await prisma.vendor.findUnique({
      where: { id: data.vendorId },
    });

    if (!vendor) {
      const error = new Error('Vendor not found');
      (error as any).statusCode = 404;
      throw error;
    }

    const location = await prisma.locations.findUnique({
      where: { id: data.locationId },
    });

    if (!location) {
      const error = new Error('Location not found');
      (error as any).statusCode = 404;
      throw error;
    }

    if (data.code) {
      const existing = await prisma.vendorWarehouse.findFirst({
        where: {
          vendorId: data.vendorId,
          code: data.code,
          type: data.type || WarehouseType.PICKUP,
        },
      });

      if (existing) {
        const error = new Error('Warehouse with this code and type already exists');
        (error as any).statusCode = 409;
        throw error;
      }
    }

    if (data.isDefault) {
      await prisma.vendorWarehouse.updateMany({
        where: {
          vendorId: data.vendorId,
          type: data.type || WarehouseType.PICKUP,
          isDefault: true,
        },
        data: { isDefault: false },
      });
    }

    const warehouse = await prisma.vendorWarehouse.create({
      data: {
        vendorId: data.vendorId,
        locationId: data.locationId,
        code: data.code,
        name: data.name,
        address: data.address,
        email: data.email,
        phone: data.phone,
        isDefault: data.isDefault || false,
        type: data.type || WarehouseType.PICKUP,
      },
      include: {
        vendor: true,
        location: true,
      },
    });

    return warehouse;
  }

  async getWarehousesByVendor(
    vendorId: string,
    filters: {
      type?: typeof WarehouseType[keyof typeof WarehouseType];
      isDefault?: boolean;
      locationId?: string;
    } = {}
  ) {
    const where: Prisma.VendorWarehouseWhereInput = { vendorId };

    if (filters.type) where.type = filters.type;
    if (filters.isDefault !== undefined) where.isDefault = filters.isDefault;
    if (filters.locationId) where.locationId = filters.locationId;

    const warehouses = await prisma.vendorWarehouse.findMany({
      where,
      include: {
        vendor: true,
        location: true,
        holidays: {
          where: {
            end: { gte: new Date() },
          },
          orderBy: { start: 'asc' },
        },
      },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
    });

    return warehouses;
  }

  async getWarehouseById(id: string, includeHolidays: boolean = false) {
    const warehouse = await prisma.vendorWarehouse.findUnique({
      where: { id },
      include: {
        vendor: true,
        location: true,
        holidays: includeHolidays
          ? {
              orderBy: { start: 'asc' },
            }
          : false,
      },
    });

    if (!warehouse) {
      const error = new Error('Warehouse not found');
      (error as any).statusCode = 404;
      throw error;
    }

    return warehouse;
  }

  async updateWarehouse(id: string, data: UpdateWarehouseInput) {
    const existing = await prisma.vendorWarehouse.findUnique({
      where: { id },
    });

    if (!existing) {
      const error = new Error('Warehouse not found');
      (error as any).statusCode = 404;
      throw error;
    }

    if (data.code && data.code !== existing.code) {
      const duplicate = await prisma.vendorWarehouse.findFirst({
        where: {
          vendorId: existing.vendorId,
          code: data.code,
          type: data.type || existing.type,
          id: { not: id },
        },
      });

      if (duplicate) {
        const error = new Error('Warehouse with this code and type already exists');
        (error as any).statusCode = 409;
        throw error;
      }
    }

    if (data.isDefault) {
      await prisma.vendorWarehouse.updateMany({
        where: {
          vendorId: existing.vendorId,
          type: data.type || existing.type,
          isDefault: true,
          id: { not: id },
        },
        data: { isDefault: false },
      });
    }

    const warehouse = await prisma.vendorWarehouse.update({
      where: { id },
      data,
      include: {
        vendor: true,
        location: true,
      },
    });

    return warehouse;
  }

  async deleteWarehouse(id: string) {
    const warehouse = await prisma.vendorWarehouse.findUnique({
      where: { id },
    });

    if (!warehouse) {
      const error = new Error('Warehouse not found');
      (error as any).statusCode = 404;
      throw error;
    }

    await prisma.vendorWarehouse.delete({
      where: { id },
    });

    return { success: true };
  }

  async setDefaultWarehouse(id: string) {
    const warehouse = await prisma.vendorWarehouse.findUnique({
      where: { id },
    });

    if (!warehouse) {
      const error = new Error('Warehouse not found');
      (error as any).statusCode = 404;
      throw error;
    }

    await prisma.vendorWarehouse.updateMany({
      where: {
        vendorId: warehouse.vendorId,
        type: warehouse.type,
        isDefault: true,
        id: { not: id },
      },
      data: { isDefault: false },
    });

    const updated = await prisma.vendorWarehouse.update({
      where: { id },
      data: { isDefault: true },
      include: {
        vendor: true,
        location: true,
      },
    });

    return updated;
  }

  async createHoliday(data: CreateHolidayInput) {
    const warehouse = await prisma.vendorWarehouse.findUnique({
      where: { id: data.warehouseId },
    });

    if (!warehouse) {
      const error = new Error('Warehouse not found');
      (error as any).statusCode = 404;
      throw error;
    }

    if (data.start >= data.end) {
      const error = new Error('End date must be after start date');
      (error as any).statusCode = 400;
      throw error;
    }

    const overlapping = await prisma.warehouseHoliday.findFirst({
      where: {
        warehouseId: data.warehouseId,
        OR: [
          {
            AND: [
              { start: { lte: data.start } },
              { end: { gte: data.start } },
            ],
          },
          {
            AND: [
              { start: { lte: data.end } },
              { end: { gte: data.end } },
            ],
          },
          {
            AND: [
              { start: { gte: data.start } },
              { end: { lte: data.end } },
            ],
          },
        ],
      },
    });

    if (overlapping) {
      const error = new Error('Holiday period overlaps with existing holiday');
      (error as any).statusCode = 409;
      throw error;
    }

    const holiday = await prisma.warehouseHoliday.create({
      data: {
        warehouseId: data.warehouseId,
        start: data.start,
        end: data.end,
        isOpen: data.isOpen ?? true,
      },
      include: {
        warehouse: true,
      },
    });

    return holiday;
  }

  async getHolidaysByWarehouse(
    warehouseId: string,
    filters: {
      startDate?: Date;
      endDate?: Date;
      isOpen?: boolean;
    } = {}
  ) {
    const where: Prisma.WarehouseHolidayWhereInput = { warehouseId };

    if (filters.startDate || filters.endDate) {
      where.AND = [];
      
      if (filters.startDate) {
        where.AND.push({ end: { gte: filters.startDate } });
      }
      
      if (filters.endDate) {
        where.AND.push({ start: { lte: filters.endDate } });
      }
    }

    if (filters.isOpen !== undefined) {
      where.isOpen = filters.isOpen;
    }

    const holidays = await prisma.warehouseHoliday.findMany({
      where,
      include: {
        warehouse: true,
      },
      orderBy: { start: 'asc' },
    });

    return holidays;
  }

  async updateHoliday(id: string, data: UpdateHolidayInput) {
    const existing = await prisma.warehouseHoliday.findUnique({
      where: { id },
    });

    if (!existing) {
      const error = new Error('Holiday not found');
      (error as any).statusCode = 404;
      throw error;
    }

    const start = data.start || existing.start;
    const end = data.end || existing.end;

    if (start >= end) {
      const error = new Error('End date must be after start date');
      (error as any).statusCode = 400;
      throw error;
    }

    if (data.start || data.end) {
      const overlapping = await prisma.warehouseHoliday.findFirst({
        where: {
          warehouseId: existing.warehouseId,
          id: { not: id },
          OR: [
            {
              AND: [
                { start: { lte: start } },
                { end: { gte: start } },
              ],
            },
            {
              AND: [
                { start: { lte: end } },
                { end: { gte: end } },
              ],
            },
            {
              AND: [
                { start: { gte: start } },
                { end: { lte: end } },
              ],
            },
          ],
        },
      });

      if (overlapping) {
        const error = new Error('Holiday period overlaps with existing holiday');
        (error as any).statusCode = 409;
        throw error;
      }
    }

    const holiday = await prisma.warehouseHoliday.update({
      where: { id },
      data,
      include: {
        warehouse: true,
      },
    });

    return holiday;
  }

  async deleteHoliday(id: string) {
    const holiday = await prisma.warehouseHoliday.findUnique({
      where: { id },
    });

    if (!holiday) {
      const error = new Error('Holiday not found');
      (error as any).statusCode = 404;
      throw error;
    }

    await prisma.warehouseHoliday.delete({
      where: { id },
    });

    return { success: true };
  }
}