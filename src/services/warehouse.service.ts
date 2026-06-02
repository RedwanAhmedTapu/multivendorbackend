// src/services/warehouse.service.ts
import { PrismaClient } from '@prisma/client';
import type { WarehouseType, StockMovementType, Prisma } from '@prisma/client';

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
  type?: WarehouseType;
}

interface UpdateWarehouseInput {
  locationId?: string;
  code?: string;
  name?: string;
  address?: string;
  email?: string;
  phone?: string;
  isDefault?: boolean;
  type?: WarehouseType;
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

// ─── Rack interfaces ─────────────────────────────────────────────

export interface CreateRackInput {
  warehouseId: string;
  code: string;
  label?: string;
  row?: string;
  shelf?: string;
  isActive?: boolean;
}

export interface UpdateRackInput {
  code?: string;
  label?: string;
  row?: string;
  shelf?: string;
  isActive?: boolean;
}

export interface RackFilter {
  warehouseId?: string;
  isActive?: boolean;
  row?: string;
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

// ─── Stock interfaces ────────────────────────────────────────────

export interface ReceivePurchaseOrderInput {
  purchaseOrderId: string;
  warehouseId: string;
  vendorId: string;
  /** Per-item receiving — allows partial receipt */
  items: Array<{
    purchaseOrderItemId: string;
    variantId: string;
    receivedQty: number;
    unitCost: number;
    newAvgCost: number;
    sellPrice?: number;
    rackId?: string;       // optional rack placement on receive
  }>;
  createdBy?: string;
}

export interface StockAdjustmentInput {
  variantId: string;
  warehouseId: string;
  vendorId: string;
  quantity: number;           // always positive — direction comes from movementType
  movementType: Extract<StockMovementType, 'ADJUSTMENT' | 'DAMAGE' | 'RETURN'>;
  rackId?: string;            // optional: scope adjustment to a specific rack
  reason?: string;
  notes?: string;
  createdBy?: string;
}

export interface StockTransferInput {
  variantId: string;
  fromWarehouseId: string;
  toWarehouseId: string;
  vendorId: string;
  quantity: number;
  toRackId?: string;          // optional: place stock in a specific rack in destination
  reason?: string;
  notes?: string;
  saleAmount?: number;        // only for SELL_DAMAGE
  coaAccountId?: string;      // receipt account for SELL_DAMAGE
  createdBy?: string;
}

export interface WarehouseStockFilter {
  warehouseId?: string;
  variantId?: string;
  rackId?: string;            // filter by rack
  lowStockOnly?: boolean;     // qty <= reorderLevel
  outOfStockOnly?: boolean;
  page?: number;
  limit?: number;
}

export class WarehouseService {

  // ─────────────────────────────────────────────────────────────────
  // BULK CREATE / UPDATE
  // ─────────────────────────────────────────────────────────────────

  async createOrUpdateBulkWarehouses(vendorId: string, data: BulkWarehouseInput) {
    const vendor = await prisma.vendor.findUnique({ where: { id: vendorId } });
    if (!vendor) {
      const error = new Error('Vendor not found');
      (error as any).statusCode = 404;
      throw error;
    }

    const result: any = {};

    if (data.pickupWarehouse) {
      const pickupLocation = await prisma.locations.findUnique({
        where: { id: data.pickupWarehouse.locationId },
      });
      if (!pickupLocation) {
        const error = new Error('Pickup location not found');
        (error as any).statusCode = 404;
        throw error;
      }

      const existingPickup = await prisma.vendorWarehouse.findFirst({
        where: { vendorId, type: 'PICKUP' },
      });

      const pickupData = {
        locationId: data.pickupWarehouse.locationId,
        address: data.pickupWarehouse.address,
        code: data.pickupWarehouse.code,
        name: data.pickupWarehouse.name,
        email: data.pickupWarehouse.email,
        phone: data.pickupWarehouse.phone,
        isDefault: true,
      };

      result.pickupWarehouse = existingPickup
        ? await prisma.vendorWarehouse.update({
            where: { id: existingPickup.id },
            data: pickupData,
            include: { vendor: true, location: true },
          })
        : await prisma.vendorWarehouse.create({
            data: { ...pickupData, vendorId, type: 'PICKUP' },
            include: { vendor: true, location: true },
          });
    }

    if (data.returnWarehouse && !data.returnWarehouse.sameAsPickup) {
      const returnLocation = await prisma.locations.findUnique({
        where: { id: data.returnWarehouse.locationId },
      });
      if (!returnLocation) {
        const error = new Error('Return location not found');
        (error as any).statusCode = 404;
        throw error;
      }

      const existingReturn = await prisma.vendorWarehouse.findFirst({
        where: { vendorId, type: 'RETURN' },
      });

      const returnData = {
        locationId: data.returnWarehouse.locationId,
        address: data.returnWarehouse.address,
        code: data.returnWarehouse.code,
        name: data.returnWarehouse.name,
        email: data.returnWarehouse.email,
        phone: data.returnWarehouse.phone,
        isDefault: false,
      };

      result.returnWarehouse = existingReturn
        ? await prisma.vendorWarehouse.update({
            where: { id: existingReturn.id },
            data: returnData,
            include: { vendor: true, location: true },
          })
        : await prisma.vendorWarehouse.create({
            data: { ...returnData, vendorId, type: 'RETURN' },
            include: { vendor: true, location: true },
          });

    } else if (data.returnWarehouse?.sameAsPickup) {
      const existingReturn = await prisma.vendorWarehouse.findFirst({
        where: { vendorId, type: 'RETURN' },
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

      result.returnWarehouse = existingReturn
        ? await prisma.vendorWarehouse.update({
            where: { id: existingReturn.id },
            data: returnData,
            include: { vendor: true, location: true },
          })
        : await prisma.vendorWarehouse.create({
            data: { ...returnData, vendorId, type: 'RETURN' },
            include: { vendor: true, location: true },
          });
    }

    return result;
  }

  // ─────────────────────────────────────────────────────────────────
  // WAREHOUSE CRUD
  // ─────────────────────────────────────────────────────────────────

  async createWarehouse(data: CreateWarehouseInput) {
    const vendor = await prisma.vendor.findUnique({ where: { id: data.vendorId } });
    if (!vendor) {
      const error = new Error('Vendor not found');
      (error as any).statusCode = 404;
      throw error;
    }

    const location = await prisma.locations.findUnique({ where: { id: data.locationId } });
    if (!location) {
      const error = new Error('Location not found');
      (error as any).statusCode = 404;
      throw error;
    }

    if (data.code) {
      const existing = await prisma.vendorWarehouse.findFirst({
        where: { vendorId: data.vendorId, code: data.code, type: data.type || 'PICKUP' },
      });
      if (existing) {
        const error = new Error('Warehouse with this code and type already exists');
        (error as any).statusCode = 409;
        throw error;
      }
    }

    if (data.isDefault) {
      await prisma.vendorWarehouse.updateMany({
        where: { vendorId: data.vendorId, type: data.type || 'PICKUP', isDefault: true },
        data: { isDefault: false },
      });
    }

    return prisma.vendorWarehouse.create({
      data: {
        vendorId: data.vendorId,
        locationId: data.locationId,
        code: data.code,
        name: data.name,
        address: data.address,
        email: data.email,
        phone: data.phone,
        isDefault: data.isDefault || false,
        type: data.type || 'PICKUP',
      },
      include: { vendor: true, location: true },
    });
  }

  async getWarehousesByVendor(
    vendorId: string,
    filters: { type?: WarehouseType; isDefault?: boolean; locationId?: string } = {}
  ) {
    const where: Prisma.VendorWarehouseWhereInput = { vendorId };
    if (filters.type) where.type = filters.type;
    if (filters.isDefault !== undefined) where.isDefault = filters.isDefault;
    if (filters.locationId) where.locationId = filters.locationId;

    return prisma.vendorWarehouse.findMany({
      where,
      include: {
        vendor: true,
        location: true,
        holidays: {
          where: { end: { gte: new Date() } },
          orderBy: { start: 'asc' },
        },
        racks: {
          where: { isActive: true },
          orderBy: { code: 'asc' },
        },
        warehouseStock: {
          include: {
            variant: {
              include: {
                product: { select: { id: true, name: true } },
              },
            },
            rack: { select: { id: true, code: true, label: true } },
          },
        },
      },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
    });
  }

  async getWarehouseById(id: string, includeHolidays = false) {
    const warehouse = await prisma.vendorWarehouse.findUnique({
      where: { id },
      include: {
        vendor: true,
        location: true,
        holidays: includeHolidays ? { orderBy: { start: 'asc' } } : false,
        racks: {
          orderBy: [{ row: 'asc' }, { code: 'asc' }],
        },
        warehouseStock: {
          include: {
            variant: {
              include: {
                product: { select: { id: true, name: true, slug: true } },
              },
            },
            rack: { select: { id: true, code: true, label: true, row: true, shelf: true } },
          },
          orderBy: { updatedAt: 'desc' },
        },
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
    const existing = await prisma.vendorWarehouse.findUnique({ where: { id } });
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

    return prisma.vendorWarehouse.update({
      where: { id },
      data,
      include: { vendor: true, location: true },
    });
  }

  async deleteWarehouse(id: string) {
    const warehouse = await prisma.vendorWarehouse.findUnique({
      where: { id },
      include: { warehouseStock: true },
    });
    if (!warehouse) {
      const error = new Error('Warehouse not found');
      (error as any).statusCode = 404;
      throw error;
    }

    const hasStock = warehouse.warehouseStock.some(s => s.quantity > 0);
    if (hasStock) {
      const error = new Error(
        'Cannot delete warehouse with existing stock. Transfer or adjust stock to zero first.'
      );
      (error as any).statusCode = 409;
      throw error;
    }

    await prisma.vendorWarehouse.delete({ where: { id } });
    return { success: true };
  }

  async setDefaultWarehouse(id: string) {
    const warehouse = await prisma.vendorWarehouse.findUnique({ where: { id } });
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

    return prisma.vendorWarehouse.update({
      where: { id },
      data: { isDefault: true },
      include: { vendor: true, location: true },
    });
  }

  // ─────────────────────────────────────────────────────────────────
  // RACK CRUD
  // ─────────────────────────────────────────────────────────────────

  async createRack(data: CreateRackInput) {
    const warehouse = await prisma.vendorWarehouse.findUnique({
      where: { id: data.warehouseId },
    });
    if (!warehouse) {
      const error = new Error('Warehouse not found');
      (error as any).statusCode = 404;
      throw error;
    }

    const duplicate = await prisma.warehouseRack.findUnique({
      where: { warehouseId_code: { warehouseId: data.warehouseId, code: data.code } },
    });
    if (duplicate) {
      const error = new Error(`Rack with code "${data.code}" already exists in this warehouse`);
      (error as any).statusCode = 409;
      throw error;
    }

    return prisma.warehouseRack.create({
      data: {
        warehouseId: data.warehouseId,
        code: data.code,
        label: data.label,
        row: data.row,
        shelf: data.shelf,
        isActive: data.isActive ?? true,
      },
      include: {
        warehouse: { select: { id: true, name: true, code: true } },
      },
    });
  }

  async getRacksByWarehouse(warehouseId: string, filters: RackFilter = {}) {
    const where: Prisma.WarehouseRackWhereInput = { warehouseId };
    if (filters.isActive !== undefined) where.isActive = filters.isActive;
    if (filters.row) where.row = filters.row;

    return prisma.warehouseRack.findMany({
      where,
      include: {
        warehouse: { select: { id: true, name: true, code: true } },
        stockItems: {
          include: {
            variant: {
              include: {
                product: { select: { id: true, name: true } },
              },
            },
          },
        },
      },
      orderBy: [{ row: 'asc' }, { code: 'asc' }],
    });
  }

  async getRackById(id: string) {
    const rack = await prisma.warehouseRack.findUnique({
      where: { id },
      include: {
        warehouse: { select: { id: true, name: true, code: true } },
        stockItems: {
          include: {
            variant: {
              include: {
                product: { select: { id: true, name: true, slug: true } },
              },
            },
          },
        },
      },
    });

    if (!rack) {
      const error = new Error('Rack not found');
      (error as any).statusCode = 404;
      throw error;
    }

    return rack;
  }

  async updateRack(id: string, data: UpdateRackInput) {
    const existing = await prisma.warehouseRack.findUnique({ where: { id } });
    if (!existing) {
      const error = new Error('Rack not found');
      (error as any).statusCode = 404;
      throw error;
    }

    if (data.code && data.code !== existing.code) {
      const duplicate = await prisma.warehouseRack.findUnique({
        where: {
          warehouseId_code: { warehouseId: existing.warehouseId, code: data.code },
        },
      });
      if (duplicate) {
        const error = new Error(
          `Rack with code "${data.code}" already exists in this warehouse`
        );
        (error as any).statusCode = 409;
        throw error;
      }
    }

    return prisma.warehouseRack.update({
      where: { id },
      data,
      include: {
        warehouse: { select: { id: true, name: true, code: true } },
      },
    });
  }

  async deleteRack(id: string) {
    const rack = await prisma.warehouseRack.findUnique({
      where: { id },
      include: { stockItems: true },
    });
    if (!rack) {
      const error = new Error('Rack not found');
      (error as any).statusCode = 404;
      throw error;
    }

    const hasStock = rack.stockItems.some(s => s.quantity > 0);
    if (hasStock) {
      const error = new Error(
        'Cannot delete rack with existing stock. Move or adjust stock first.'
      );
      (error as any).statusCode = 409;
      throw error;
    }

    await prisma.warehouseRack.delete({ where: { id } });
    return { success: true };
  }

  async toggleRackActive(id: string) {
    const rack = await prisma.warehouseRack.findUnique({ where: { id } });
    if (!rack) {
      const error = new Error('Rack not found');
      (error as any).statusCode = 404;
      throw error;
    }

    return prisma.warehouseRack.update({
      where: { id },
      data: { isActive: !rack.isActive },
      include: {
        warehouse: { select: { id: true, name: true, code: true } },
      },
    });
  }

  // ─────────────────────────────────────────────────────────────────
  // HOLIDAY CRUD
  // ─────────────────────────────────────────────────────────────────

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
          { AND: [{ start: { lte: data.start } }, { end: { gte: data.start } }] },
          { AND: [{ start: { lte: data.end } }, { end: { gte: data.end } }] },
          { AND: [{ start: { gte: data.start } }, { end: { lte: data.end } }] },
        ],
      },
    });
    if (overlapping) {
      const error = new Error('Holiday period overlaps with existing holiday');
      (error as any).statusCode = 409;
      throw error;
    }

    return prisma.warehouseHoliday.create({
      data: {
        warehouseId: data.warehouseId,
        start: data.start,
        end: data.end,
        isOpen: data.isOpen ?? true,
      },
      include: { warehouse: true },
    });
  }

  async getHolidaysByWarehouse(
    warehouseId: string,
    filters: { startDate?: Date; endDate?: Date; isOpen?: boolean } = {}
  ) {
    const where: Prisma.WarehouseHolidayWhereInput = { warehouseId };

    if (filters.startDate || filters.endDate) {
      where.AND = [];
      if (filters.startDate) (where.AND as any[]).push({ end: { gte: filters.startDate } });
      if (filters.endDate) (where.AND as any[]).push({ start: { lte: filters.endDate } });
    }

    if (filters.isOpen !== undefined) where.isOpen = filters.isOpen;

    return prisma.warehouseHoliday.findMany({
      where,
      include: { warehouse: true },
      orderBy: { start: 'asc' },
    });
  }

  async updateHoliday(id: string, data: UpdateHolidayInput) {
    const existing = await prisma.warehouseHoliday.findUnique({ where: { id } });
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
            { AND: [{ start: { lte: start } }, { end: { gte: start } }] },
            { AND: [{ start: { lte: end } }, { end: { gte: end } }] },
            { AND: [{ start: { gte: start } }, { end: { lte: end } }] },
          ],
        },
      });
      if (overlapping) {
        const error = new Error('Holiday period overlaps with existing holiday');
        (error as any).statusCode = 409;
        throw error;
      }
    }

    return prisma.warehouseHoliday.update({
      where: { id },
      data,
      include: { warehouse: true },
    });
  }

  async deleteHoliday(id: string) {
    const holiday = await prisma.warehouseHoliday.findUnique({ where: { id } });
    if (!holiday) {
      const error = new Error('Holiday not found');
      (error as any).statusCode = 404;
      throw error;
    }

    await prisma.warehouseHoliday.delete({ where: { id } });
    return { success: true };
  }

  // ─────────────────────────────────────────────────────────────────
  // STOCK — RECEIVE PURCHASE ORDER
  // ─────────────────────────────────────────────────────────────────

  async receivePurchaseOrder(input: ReceivePurchaseOrderInput) {
    const warehouse = await prisma.vendorWarehouse.findUnique({
      where: { id: input.warehouseId },
    });
    if (!warehouse) {
      const error = new Error('Warehouse not found');
      (error as any).statusCode = 404;
      throw error;
    }

    const purchaseOrder = await prisma.purchaseOrder.findUnique({
      where: { id: input.purchaseOrderId },
      include: { items: true },
    });
    if (!purchaseOrder) {
      const error = new Error('Purchase order not found');
      (error as any).statusCode = 404;
      throw error;
    }

    if (purchaseOrder.warehouseId !== input.warehouseId) {
      const error = new Error(
        'Warehouse mismatch: this purchase order belongs to a different warehouse'
      );
      (error as any).statusCode = 400;
      throw error;
    }

    // Validate all rackIds belong to this warehouse (if provided)
    const rackIds = [...new Set(input.items.map(i => i.rackId).filter(Boolean))] as string[];
    if (rackIds.length > 0) {
      const racks = await prisma.warehouseRack.findMany({
        where: { id: { in: rackIds }, warehouseId: input.warehouseId, isActive: true },
      });
      if (racks.length !== rackIds.length) {
        const error = new Error(
          'One or more rack IDs are invalid, inactive, or do not belong to this warehouse'
        );
        (error as any).statusCode = 400;
        throw error;
      }
    }

    const movements: any[] = [];

    await prisma.$transaction(async (tx) => {
      for (const item of input.items) {
        if (item.receivedQty <= 0) continue;

        // 1. Upsert WarehouseStock — scoped to rack if provided
        await tx.warehouseStock.upsert({
          where: {
            variantId_warehouseId: {
              variantId: item.variantId,
              warehouseId: input.warehouseId,
            },
          },
          update: {
            quantity: { increment: item.receivedQty },
            // Update rackId only when explicitly supplied
            ...(item.rackId !== undefined ? { rackId: item.rackId } : {}),
          },
          create: {
            variantId: item.variantId,
            warehouseId: input.warehouseId,
            rackId: item.rackId ?? null,
            quantity: item.receivedQty,
            reservedQty: 0,
            damagedQty: 0,
          },
        });

        // 2. Update ProductVariant totals and costs
        await tx.productVariant.update({
          where: { id: item.variantId },
          data: {
            stock: { increment: item.receivedQty },
            avgCost: item.newAvgCost,
            ...(item.sellPrice ? { price: item.sellPrice } : {}),
          },
        });

        // 3. Record StockMovement
        const movement = await tx.stockMovement.create({
          data: {
            variantId: item.variantId,
            toWarehouseId: input.warehouseId,
            movementType: 'PURCHASE_RECEIVE',
            quantity: item.receivedQty,
            reason: `Purchase order ${purchaseOrder.purchaseNo}`,
            referenceId: item.purchaseOrderItemId,
            createdBy: input.createdBy || 'system',
          },
        });

        movements.push(movement);
      }

      // 4. Update PO status
      const totalOrdered = purchaseOrder.items.reduce((s, i) => s + i.quantity, 0);
      const totalReceived = input.items.reduce((s, i) => s + i.receivedQty, 0);
      const newStatus =
        totalReceived >= totalOrdered ? 'RECEIVED' : purchaseOrder.status;

      await tx.purchaseOrder.update({
        where: { id: input.purchaseOrderId },
        data: { status: newStatus },
      });
    });

    return {
      purchaseOrderId: input.purchaseOrderId,
      warehouseId: input.warehouseId,
      movements,
    };
  }

  // ─────────────────────────────────────────────────────────────────
  // STOCK — ADJUSTMENT / DAMAGE / RETURN
  // ─────────────────────────────────────────────────────────────────

  async adjustStock(input: StockAdjustmentInput) {
    // Validate rack ownership when rackId is provided
    if (input.rackId) {
      const rack = await prisma.warehouseRack.findUnique({ where: { id: input.rackId } });
      if (!rack || rack.warehouseId !== input.warehouseId || !rack.isActive) {
        const error = new Error('Rack is invalid, inactive, or does not belong to this warehouse');
        (error as any).statusCode = 400;
        throw error;
      }
    }

    const warehouseStock = await prisma.warehouseStock.findUnique({
      where: {
        variantId_warehouseId: {
          variantId: input.variantId,
          warehouseId: input.warehouseId,
        },
      },
    });

    if (!warehouseStock) {
      const error = new Error(
        'No stock record found for this variant in the specified warehouse'
      );
      (error as any).statusCode = 404;
      throw error;
    }

    const isDeduction =
      input.movementType === 'ADJUSTMENT' || input.movementType === 'DAMAGE';

    if (isDeduction && warehouseStock.quantity < input.quantity) {
      const error = new Error(
        `Insufficient stock. Available: ${warehouseStock.quantity}, requested: ${input.quantity}`
      );
      (error as any).statusCode = 400;
      throw error;
    }

    let movement: any;

    await prisma.$transaction(async (tx) => {
      const stockWhere = {
        variantId_warehouseId: {
          variantId: input.variantId,
          warehouseId: input.warehouseId,
        },
      };

      if (input.movementType === 'DAMAGE') {
        await tx.warehouseStock.update({
          where: stockWhere,
          data: {
            quantity: { decrement: input.quantity },
            damagedQty: { increment: input.quantity },
          },
        });
        await tx.productVariant.update({
          where: { id: input.variantId },
          data: {
            stock: { decrement: input.quantity },
            damagedQty: { increment: input.quantity },
          },
        });

      } else if (input.movementType === 'ADJUSTMENT') {
        await tx.warehouseStock.update({
          where: stockWhere,
          data: { quantity: { decrement: input.quantity } },
        });
        await tx.productVariant.update({
          where: { id: input.variantId },
          data: { stock: { decrement: input.quantity } },
        });

      } else if (input.movementType === 'RETURN') {
        await tx.warehouseStock.update({
          where: stockWhere,
          data: {
            quantity: { increment: input.quantity },
            // Assign to rack if provided
            ...(input.rackId !== undefined ? { rackId: input.rackId } : {}),
          },
        });
        await tx.productVariant.update({
          where: { id: input.variantId },
          data: { stock: { increment: input.quantity } },
        });
      }

      movement = await tx.stockMovement.create({
        data: {
          variantId: input.variantId,
          fromWarehouseId:
            input.movementType !== 'RETURN' ? input.warehouseId : undefined,
          toWarehouseId:
            input.movementType === 'RETURN' ? input.warehouseId : undefined,
          movementType: input.movementType,
          quantity: input.quantity,
          reason: input.reason,
          notes: input.notes,
          createdBy: input.createdBy || 'system',
        },
      });
    });

    return movement;
  }

  // ─────────────────────────────────────────────────────────────────
  // STOCK — WAREHOUSE TRANSFER
  // ─────────────────────────────────────────────────────────────────

  async transferStock(input: StockTransferInput) {
    if (input.fromWarehouseId === input.toWarehouseId) {
      const error = new Error('Source and destination warehouses must be different');
      (error as any).statusCode = 400;
      throw error;
    }

    // Validate destination rack when provided
    if (input.toRackId) {
      const rack = await prisma.warehouseRack.findUnique({ where: { id: input.toRackId } });
      if (!rack || rack.warehouseId !== input.toWarehouseId || !rack.isActive) {
        const error = new Error(
          'Destination rack is invalid, inactive, or does not belong to the destination warehouse'
        );
        (error as any).statusCode = 400;
        throw error;
      }
    }

    const fromStock = await prisma.warehouseStock.findUnique({
      where: {
        variantId_warehouseId: {
          variantId: input.variantId,
          warehouseId: input.fromWarehouseId,
        },
      },
    });

    if (!fromStock || fromStock.quantity < input.quantity) {
      const error = new Error(
        `Insufficient stock in source warehouse. Available: ${fromStock?.quantity ?? 0}`
      );
      (error as any).statusCode = 400;
      throw error;
    }

    let movement: any;

    await prisma.$transaction(async (tx) => {
      // Deduct from source
      await tx.warehouseStock.update({
        where: {
          variantId_warehouseId: {
            variantId: input.variantId,
            warehouseId: input.fromWarehouseId,
          },
        },
        data: { quantity: { decrement: input.quantity } },
      });

      // Add to destination (upsert — destination may not have a record yet)
      await tx.warehouseStock.upsert({
        where: {
          variantId_warehouseId: {
            variantId: input.variantId,
            warehouseId: input.toWarehouseId,
          },
        },
        update: {
          quantity: { increment: input.quantity },
          // Update rack placement in destination if specified
          ...(input.toRackId !== undefined ? { rackId: input.toRackId } : {}),
        },
        create: {
          variantId: input.variantId,
          warehouseId: input.toWarehouseId,
          rackId: input.toRackId ?? null,
          quantity: input.quantity,
          reservedQty: 0,
          damagedQty: 0,
        },
      });

      // Total variant stock unchanged — only warehouse distribution changes
      movement = await tx.stockMovement.create({
        data: {
          variantId: input.variantId,
          fromWarehouseId: input.fromWarehouseId,
          toWarehouseId: input.toWarehouseId,
          movementType: 'TRANSFER',
          quantity: input.quantity,
          reason: input.reason,
          notes: input.notes,
          saleAmount: input.saleAmount,
          coaAccountId: input.coaAccountId,
          createdBy: input.createdBy || 'system',
        },
      });
    });

    return movement;
  }

  // ─────────────────────────────────────────────────────────────────
  // STOCK — SELL DAMAGED STOCK
  // ─────────────────────────────────────────────────────────────────

  async sellDamagedStock(input: StockTransferInput) {
    const warehouseStock = await prisma.warehouseStock.findUnique({
      where: {
        variantId_warehouseId: {
          variantId: input.variantId,
          warehouseId: input.fromWarehouseId,
        },
      },
    });

    if (!warehouseStock || warehouseStock.damagedQty < input.quantity) {
      const error = new Error(
        `Insufficient damaged stock. Available damaged: ${warehouseStock?.damagedQty ?? 0}`
      );
      (error as any).statusCode = 400;
      throw error;
    }

    let movement: any;

    await prisma.$transaction(async (tx) => {
      await tx.warehouseStock.update({
        where: {
          variantId_warehouseId: {
            variantId: input.variantId,
            warehouseId: input.fromWarehouseId,
          },
        },
        data: { damagedQty: { decrement: input.quantity } },
      });

      await tx.productVariant.update({
        where: { id: input.variantId },
        data: { damagedQty: { decrement: input.quantity } },
      });

      movement = await tx.stockMovement.create({
        data: {
          variantId: input.variantId,
          fromWarehouseId: input.fromWarehouseId,
          movementType: 'SELL_DAMAGE',
          quantity: input.quantity,
          reason: input.reason,
          notes: input.notes,
          saleAmount: input.saleAmount,
          coaAccountId: input.coaAccountId,
          createdBy: input.createdBy || 'system',
        },
      });
    });

    return movement;
  }

  // ─────────────────────────────────────────────────────────────────
  // STOCK — QUERY
  // ─────────────────────────────────────────────────────────────────

  async getWarehouseStock(filters: WarehouseStockFilter) {
    const page = filters.page || 1;
    const limit = filters.limit || 20;
    const skip = (page - 1) * limit;

    const where: Prisma.WarehouseStockWhereInput = {};
    if (filters.warehouseId) where.warehouseId = filters.warehouseId;
    if (filters.variantId) where.variantId = filters.variantId;
    if (filters.rackId) where.rackId = filters.rackId;
    if (filters.outOfStockOnly) where.quantity = 0;

    const [rows, total] = await Promise.all([
      prisma.warehouseStock.findMany({
        where,
        include: {
          warehouse: {
            select: { id: true, name: true, code: true, type: true, location: true },
          },
          rack: {
            select: { id: true, code: true, label: true, row: true, shelf: true },
          },
          variant: {
            include: {
              product: { select: { id: true, name: true, slug: true } },
            },
          },
        },
        orderBy: { updatedAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.warehouseStock.count({ where }),
    ]);

    const filtered = filters.lowStockOnly
      ? rows.filter(r => r.quantity <= ((r.variant as any).reorderLevel ?? 10))
      : rows;

    return {
      data: filtered,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    };
  }

  async getStockMovements(filters: {
    variantId?: string;
    warehouseId?: string;
    movementType?: StockMovementType;
    startDate?: Date;
    endDate?: Date;
    page?: number;
    limit?: number;
  }) {
    const page = filters.page || 1;
    const limit = filters.limit || 20;
    const skip = (page - 1) * limit;

    const where: Prisma.StockMovementWhereInput = {};
    if (filters.variantId) where.variantId = filters.variantId;
    if (filters.movementType) where.movementType = filters.movementType;
    if (filters.warehouseId) {
      where.OR = [
        { fromWarehouseId: filters.warehouseId },
        { toWarehouseId: filters.warehouseId },
      ];
    }
    if (filters.startDate || filters.endDate) {
      where.createdAt = {};
      if (filters.startDate) where.createdAt.gte = filters.startDate;
      if (filters.endDate) where.createdAt.lte = filters.endDate;
    }

    const [movements, total] = await Promise.all([
      prisma.stockMovement.findMany({
        where,
        include: {
          variant: {
            include: {
              product: { select: { id: true, name: true } },
            },
          },
          fromWarehouse: { select: { id: true, name: true, code: true } },
          toWarehouse: { select: { id: true, name: true, code: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.stockMovement.count({ where }),
    ]);

    return {
      data: movements,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    };
  }
}