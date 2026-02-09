// services/cartWish.service.ts
import { PrismaClient } from "@prisma/client";
import { v4 as uuidv4 } from "uuid";
import courierService from '../services/courier.service.ts';

const prisma = new PrismaClient();

interface AddToCartRequest {
  userId?: string;
  sessionId?: string;
  productId: string;
  variantId: string;
  quantity: number;
  notes?: string;
}

interface UpdateCartItemRequest {
  quantity?: number;
  isSelected?: boolean;
  notes?: string;
}

interface AddToWishlistRequest {
  userId: string;
  productId: string;
  variantId?: string;
  priority?: number;
  notes?: string;
  notifyOnDiscount?: boolean;
  notifyOnRestock?: boolean;
}

interface CartSummary {
  totalItems: number;
  selectedItems: number;
  subtotal: number;
  selectedSubtotal: number;
  items: any[];
}

export class CartWishService {
  // ==================== CART METHODS ====================

  /**
   * Get or create cart for user/session
   */
  async getOrCreateCart(
  userId?: string,
  sessionId?: string,
  fingerprint?: string
) {
  if (!userId && !sessionId) {
    throw new Error("Either userId or sessionId is required");
  }

  const now = new Date();
  let cart = null;

  // 1️⃣ Prefer user cart
  if (userId) {
    cart = await prisma.carts.findUnique({
      where: { userId }
    });
  }

  // 2️⃣ Fallback to session cart
  if (!cart && sessionId) {
    cart = await prisma.carts.findUnique({
      where: { sessionId }
    });
  }

  // 3️⃣ Create cart if none exists
  if (!cart) {
    cart = await prisma.carts.create({
      data: {
        userId: userId || null,
        sessionId: sessionId || uuidv4(),
        fingerprint,
        isGuest: !userId,
        lastActivityAt: now,
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      }
    });
  }

  // 4️⃣ If guest cart → user logged in (VERY IMPORTANT)
  if (userId && cart.isGuest) {
    cart = await prisma.carts.update({
      where: { id: cart.id },
      data: {
        userId,
        isGuest: false,
        updatedAt: now
      }
    });
  }

  // 5️⃣ Update activity
  await prisma.carts.update({
    where: { id: cart.id },
    data: {
      lastActivityAt: now,
      updatedAt: now
    }
  });

  return cart;
}

  /**
   * Add item to cart
   */
  async addToCart(data: AddToCartRequest) {
    // Get or create cart
    const cart = await this.getOrCreateCart(data.userId, data.sessionId);

    // Check if product and variant exist
    const variant = await prisma.productVariant.findUnique({
      where: { id: data.variantId },
      include: {
        product: {
          select: {
            id: true,
            name: true,
            slug: true,
            vendorId: true,
          },
        },
      },
    });

    if (!variant) {
      throw new Error("Product variant not found");
    }

    if (variant.productId !== data.productId) {
      throw new Error("Variant does not belong to the specified product");
    }

    // Check stock availability
    if (variant.stock < data.quantity) {
      throw new Error(
        `Insufficient stock. Available: ${variant.stock}, Requested: ${data.quantity}`
      );
    }

    // Check if item already exists in cart
    const existingItem = await prisma.cart_items.findUnique({
      where: {
        cartId_variantId: {
          cartId: cart.id,
          variantId: data.variantId,
        },
      },
    });

    let cartItem;

    if (existingItem) {
      // Update quantity
      const newQuantity = existingItem.quantity + data.quantity;

      // Check stock for new quantity
      if (variant.stock < newQuantity) {
        throw new Error(
          `Insufficient stock. Available: ${variant.stock}, Total requested: ${newQuantity}`
        );
      }

      cartItem = await prisma.cart_items.update({
        where: { id: existingItem.id },
        data: {
          quantity: newQuantity,
          updatedAt: new Date(),
          lastSelectedAt: new Date(),
        },
      });
    } else {
      // Create new cart item
      cartItem = await prisma.cart_items.create({
        data: {
          id: uuidv4(),
          cartId: cart.id,
          productId: data.productId,
          variantId: data.variantId,
          quantity: data.quantity,
          price: variant.price,
          compareAtPrice: variant.specialPrice,
          notes: data.notes,
          isSelected: true,
          lastSelectedAt: new Date(),
        },
      });
    }

    // Return cart item with product details
    return await prisma.cart_items.findUnique({
      where: { id: cartItem.id },
      include: {
        products: {
          select: {
            id: true,
            name: true,
            slug: true,

            vendorId: true,
          },
        },
        product_variants: {
          select: {
            id: true,
            sku: true,
            price: true,
            specialPrice: true,
            stock: true,
            // weight: true,  // Remove if doesn't exist in your schema
            // variantImage: true,  // Remove if doesn't exist
            // attributeValues: true,  // Remove if doesn't exist
          },
        },
      },
    });
  }

  /**
   * Update cart item
   */
  async updateCartItem(
    cartItemId: string,
    data: UpdateCartItemRequest,
    userId?: string,
    sessionId?: string
  ) {
    // Verify cart item belongs to user/session
    const cartItem = await prisma.cart_items.findUnique({
      where: { id: cartItemId },
      include: {
        carts: true,
        product_variants: {
          select: { stock: true },
        },
      },
    });

    if (!cartItem) {
      throw new Error("Cart item not found");
    }

    // Verify ownership
    if (userId && cartItem.carts.userId !== userId) {
      throw new Error("Unauthorized");
    }
    if (sessionId && cartItem.carts.sessionId !== sessionId) {
      throw new Error("Unauthorized");
    }

    // If updating quantity, check stock
    if (data.quantity !== undefined) {
      if (data.quantity <= 0) {
        throw new Error("Quantity must be greater than 0");
      }

      if (cartItem.product_variants.stock < data.quantity) {
        throw new Error(
          `Insufficient stock. Available: ${cartItem.product_variants.stock}`
        );
      }
    }

    // Update cart item
    const updateData: any = { updatedAt: new Date() };
    if (data.quantity !== undefined) updateData.quantity = data.quantity;
    if (data.notes !== undefined) updateData.notes = data.notes;
    if (data.isSelected !== undefined) {
      updateData.isSelected = data.isSelected;
      if (data.isSelected) {
        updateData.lastSelectedAt = new Date();
      }
    }

    return await prisma.cart_items.update({
      where: { id: cartItemId },
      data: updateData,
      include: {
        products: {
          select: {
            id: true,
            name: true,
            slug: true,

            vendorId: true,
          },
        },
        product_variants: {
          select: {
            id: true,
            sku: true,
            price: true,
            specialPrice: true,
            stock: true,
          },
        },
      },
    });
  }

  /**
   * Remove item from cart
   */
  async removeFromCart(
    cartItemId: string,
    userId?: string,
    sessionId?: string
  ) {
    // Verify cart item belongs to user/session
    const cartItem = await prisma.cart_items.findUnique({
      where: { id: cartItemId },
      include: { carts: true },
    });

    if (!cartItem) {
      throw new Error("Cart item not found");
    }

    // Verify ownership
    if (userId && cartItem.carts.userId !== userId) {
      throw new Error("Unauthorized");
    }
    if (sessionId && cartItem.carts.sessionId !== sessionId) {
      throw new Error("Unauthorized");
    }

    await prisma.cart_items.delete({
      where: { id: cartItemId },
    });

    return { success: true, message: "Item removed from cart" };
  }

  /**
   * Get cart with all items
   */
  async getCart(userId?: string, sessionId?: string): Promise<CartSummary> {
    if (!userId && !sessionId) {
      throw new Error("Either userId or sessionId is required");
    }

    const cart = await prisma.carts.findFirst({
      where: userId ? { userId } : { sessionId },
      include: {
        cart_items: {
          include: {
            products: {
              select: {
                id: true,
                name: true,
                slug: true,

                vendorId: true,
              },
            },
            product_variants: {
              select: {
                id: true,
                sku: true,
                price: true,
                specialPrice: true,
                stock: true,
              },
            },
          },
          orderBy: { addedAt: "desc" },
        },
      },
    });

    if (!cart) {
      return {
        totalItems: 0,
        selectedItems: 0,
        subtotal: 0,
        selectedSubtotal: 0,
        items: [],
      };
    }

    // Calculate totals
    const totalItems = cart.cart_items.reduce(
      (sum, item) => sum + item.quantity,
      0
    );
    const selectedItems = cart.cart_items
      .filter((item) => item.isSelected)
      .reduce((sum, item) => sum + item.quantity, 0);

    const subtotal = cart.cart_items.reduce(
      (sum, item) => sum + item.price * item.quantity,
      0
    );

    const selectedSubtotal = cart.cart_items
      .filter((item) => item.isSelected)
      .reduce((sum, item) => sum + item.price * item.quantity, 0);

    // Enhance items with calculated fields
    const items = cart.cart_items.map((item) => ({
      ...item,
      itemTotal: item.price * item.quantity,
      savings: item.compareAtPrice
        ? (item.compareAtPrice - item.price) * item.quantity
        : 0,
      isInStock: item.product_variants.stock >= item.quantity,
      availableStock: item.product_variants.stock,
    }));

    return {
      totalItems,
      selectedItems,
      subtotal,
      selectedSubtotal,
      items,
    };
  }


/**
 * Calculate delivery fees for each vendor using courier service
 */
// Add this method to get vendor groups from cart
private async getVendorGroupsFromCart(
  userId?: string,
  sessionId?: string,
  selectedItemIds?: string[]
): Promise<any[]> {
  // Build the where clause for cart items
  const whereClause: any = {
    OR: []
  };
  
  if (userId) {
    whereClause.OR.push({ userId });
  }
  
  if (sessionId) {
    whereClause.OR.push({ sessionId });
  }
  
  // If no conditions, return empty array
  if (whereClause.OR.length === 0) {
    return [];
  }

  // Find the cart
  const cart = await prisma.carts.findFirst({
    where: whereClause,
    include: {
      cart_items: {
        where: selectedItemIds && selectedItemIds.length > 0 
          ? { id: { in: selectedItemIds } } 
          : {},
        include: {
          products: {
            include: {
              vendor: true // Just get vendor basic info
            }
          },
          product_variants: {
            include: {
              product: {
                include: {
                  vendor: true
                }
              }
            }
          }
        }
      }
    }
  });

  if (!cart || cart.cart_items.length === 0) {
    return [];
  }

  // Get all vendor IDs from cart items
  const vendorIds = [...new Set(cart.cart_items.map(item => item.products.vendorId))];
  
  // Fetch warehouses for these vendors
  const warehouses = await prisma.vendorWarehouse.findMany({
    where: {
      vendorId: { in: vendorIds }
    },
    include: {
      location: true
    }
  });

  // Group warehouses by vendorId (take the default or first warehouse)
  const warehousesByVendor = new Map();
  warehouses.forEach(warehouse => {
    const vendorId = warehouse.vendorId;
    
    // If vendor doesn't have a warehouse yet, or this is the default warehouse
    if (!warehousesByVendor.has(vendorId) || warehouse.isDefault) {
      warehousesByVendor.set(vendorId, warehouse);
    }
  });

  // Group items by vendor
  const vendorGroupsMap = new Map();
  
  for (const item of cart.cart_items) {
    const vendor = item.products.vendor;
    const vendorId = vendor.id;
    
    // Get warehouse for this vendor
    const vendorWarehouse = warehousesByVendor.get(vendorId);
    
    if (!vendorGroupsMap.has(vendorId)) {
      vendorGroupsMap.set(vendorId, {
        vendor: {
          id: vendor.id,
          name: vendor.storeName || vendor.id, // Use storeName from Vendor
        },
        warehouse: vendorWarehouse,
        items: [],
        subtotal: 0
      });
    }
    
    const group = vendorGroupsMap.get(vendorId);
    const itemTotal = item.price * item.quantity;
    
    // Get variant weight - check your schema for where weight is stored
    // Looking at your schema, weight is in Warranty model, not in ProductVariant
    // We'll use a default weight of 0.5kg for now
    const variantWeight = 0.5; // Default weight in kg
    
    group.items.push({
      id: item.id,
      variant: {
        id: item.variantId,
        name: item.product_variants?.name || 
              item.product_variants?.sku || 
              'Default',
        weight: variantWeight,
        product: {
          id: item.products.id,
          name: item.products.name,
          vendor: item.products.vendor
        }
      },
      price: item.price,
      quantity: item.quantity
    });
    group.subtotal += itemTotal;
  }
  
  return Array.from(vendorGroupsMap.values());
}

// Rename your existing method for internal use
private async calculateDeliveryFeesForVendorGroups(
  vendorGroups: any[],
  userAddressId: string,
  codEnabled: boolean = false
) {
  console.log(userAddressId);
  const userAddress = await prisma.userAddress.findUnique({
    where: { id: userAddressId },
    include: { locations: true }
  });

  if (!userAddress) throw new Error('User address not found');

  const deliveryCalculations = [];

  for (const group of vendorGroups) {
    const vendorWarehouse = group.warehouse;
    
    if (!vendorWarehouse) {
      deliveryCalculations.push({
        vendorId: group.vendor.id,
        vendorName: group.vendor.name,
        error: 'No warehouse configured',
        shippingCost: 0,
        courierProvider: null,
        courierProviderId: null,
        deliveryCharge: 0,
        codCharge: 0,
        estimatedDeliveryDays: null,
        subtotal: group.subtotal,
        items: group.items
      });
      continue;
    }

    // Calculate total weight of items from this vendor
    const totalWeight = group.items.reduce((sum: number, item: any) => {
      return sum + (item.variant.weight || 0.5) * item.quantity;
    }, 0);

    // Calculate COD amount if enabled
    const codAmount = codEnabled ? group.subtotal : 0;

    try {
      // Call the service method (not controller)
      // This calls selectBestCourier which compares Pathao, RedX, etc.
      const quote = await courierService.selectBestCourier({
        vendorWarehouseLocationId: vendorWarehouse.locationId,
        customerDeliveryLocationId: userAddress.locationId,
        orderWeight: totalWeight,
        codAmount: codAmount,
        deliveryType: 'NORMAL'
      });

      deliveryCalculations.push({
        vendorId: group.vendor.id,
        vendorName: group.vendor.name,
        warehouseLocation: vendorWarehouse.location?.name || 'Unknown',
        warehouseLocationId: vendorWarehouse.locationId,
        deliveryLocation: userAddress.locations?.name || 'Unknown',
        deliveryLocationId: userAddress.locationId,
        totalWeight: Math.round(totalWeight * 100) / 100,
        
        // Courier information from quote
        courierProviderId: quote.courierProviderId,
        courierProvider: quote.courierName,
        deliveryCharge: quote.pricing.deliveryCharge,
        codCharge: quote.pricing.codCharge,
        shippingCost: quote.pricing.totalCharge,
        estimatedDeliveryDays: quote.pricing.estimatedDeliveryDays,
        
        // Order summary
        subtotal: group.subtotal,
        codAmount: codAmount,
        
        items: group.items.map((item: any) => ({
          id: item.id,
          productName: item.variant.product?.name || 'Unknown',
          variantName: item.variant.name || 'Default',
          quantity: item.quantity,
          price: item.price,
          weight: item.variant.weight || 0.5
        }))
      });

    } catch (error: any) {
      console.error(`Failed to get quote for vendor ${group.vendor.name}:`, error.message);
      
      // Fallback to manual calculation or default pricing
      deliveryCalculations.push({
        vendorId: group.vendor.id,
        vendorName: group.vendor.name,
        warehouseLocation: vendorWarehouse.location?.name || 'Unknown',
        warehouseLocationId: vendorWarehouse.locationId,
        deliveryLocation: userAddress.locations?.name || 'Unknown',
        deliveryLocationId: userAddress.locationId,
        totalWeight: Math.round(totalWeight * 100) / 100,
        error: error.message,
        shippingCost: 60, 
        deliveryCharge: 60,
        codCharge: 0,
        courierProvider: 'Manual',
        courierProviderId: null,
        estimatedDeliveryDays: 3,
        subtotal: group.subtotal,
        codAmount: codAmount,
        items: group.items.map((item: any) => ({
          id: item.id,
          productName: item.variant.product?.name || 'Unknown',
          variantName: item.variant.name || 'Default',
          quantity: item.quantity,
          price: item.price,
          weight: item.variant.weight || 0.5
        }))
      });
    }
  }

  return deliveryCalculations;
}

// Add this NEW PUBLIC METHOD that your controller expects
async calculateDeliveryFees(
  userId: string | undefined,
  sessionId: string,
  userAddressId: string,
  codEnabled: boolean = false,
  selectedItemIds?: string[]
) {
  // Input validation
  if (!userAddressId) {
    throw new Error('User address ID is required');
  }

  if (!sessionId && !userId) {
    throw new Error('Session ID or User ID is required');
  }

  // 1. Get vendor groups from cart
  const vendorGroups = await this.getVendorGroupsFromCart(
    userId,
    sessionId,
    selectedItemIds
  );
  
  // 2. Validate we have items
  if (vendorGroups.length === 0) {
    throw new Error('No items found in cart');
  }
  
  // 3. Calculate delivery fees using your existing logic
  return this.calculateDeliveryFeesForVendorGroups(
    vendorGroups,
    userAddressId,
    codEnabled
  );
}
  /**
   * Toggle item selection (check/uncheck)
   */
  async toggleItemSelection(
    cartItemId: string,
    userId?: string,
    sessionId?: string
  ) {
    const cartItem = await prisma.cart_items.findUnique({
      where: { id: cartItemId },
      include: { carts: true },
    });

    if (!cartItem) {
      throw new Error("Cart item not found");
    }

    // Verify ownership
    if (userId && cartItem.carts.userId !== userId) {
      throw new Error("Unauthorized");
    }
    if (sessionId && cartItem.carts.sessionId !== sessionId) {
      throw new Error("Unauthorized");
    }

    const newSelectionState = !cartItem.isSelected;

    return await prisma.cart_items.update({
      where: { id: cartItemId },
      data: {
        isSelected: newSelectionState,
        lastSelectedAt: newSelectionState
          ? new Date()
          : cartItem.lastSelectedAt,
        updatedAt: new Date(),
      },
    });
  }

  /**
   * Select/Deselect all items in cart
   */
  async toggleAllItems(
    isSelected: boolean,
    userId?: string,
    sessionId?: string
  ) {
    if (!userId && !sessionId) {
      throw new Error("Either userId or sessionId is required");
    }

    const cart = await prisma.carts.findFirst({
      where: userId ? { userId } : { sessionId },
    });

    if (!cart) {
      throw new Error("Cart not found");
    }

    await prisma.cart_items.updateMany({
      where: { cartId: cart.id },
      data: {
        isSelected,
        lastSelectedAt: isSelected ? new Date() : undefined,
        updatedAt: new Date(),
      },
    });

    return {
      success: true,
      message: `All items ${isSelected ? "selected" : "deselected"}`,
    };
  }

  /**
   * Clear all items from cart
   */
  async clearCart(userId?: string, sessionId?: string) {
    if (!userId && !sessionId) {
      throw new Error("Either userId or sessionId is required");
    }

    const cart = await prisma.carts.findFirst({
      where: userId ? { userId } : { sessionId },
    });

    if (!cart) {
      throw new Error("Cart not found");
    }

    await prisma.cart_items.deleteMany({
      where: { cartId: cart.id },
    });

    return { success: true, message: "Cart cleared" };
  }

  /**
   * Get selected items summary (for checkout)
   */
  async getSelectedItemsSummary(userId?: string, sessionId?: string) {
    const cart = await this.getCart(userId, sessionId);

    const selectedItems = cart.items.filter((item) => item.isSelected);

    // Group by vendor for multi-vendor checkout
    const itemsByVendor = selectedItems.reduce((acc, item) => {
      const vendorId = item.products.vendorId;
      if (!acc[vendorId]) {
        acc[vendorId] = {
          vendorId,
          items: [],
          subtotal: 0,
          totalWeight: 0,
        };
      }
      acc[vendorId].items.push(item);
      acc[vendorId].subtotal += item.itemTotal;
      // Remove or adjust weight calculation if not in your schema
      // acc[vendorId].totalWeight += item.product_variants.weight * item.quantity;
      return acc;
    }, {} as Record<string, any>);

    return {
      selectedItems: selectedItems.length,
      selectedItemsCount: cart.selectedItems,
      subtotal: cart.selectedSubtotal,
      itemsByVendor: Object.values(itemsByVendor),
    };
  }

  /**
   * Merge guest cart into user cart (after login)
   */
  async mergeGuestCart(userId: string, guestSessionId: string) {
    // Get guest cart
    const guestCart = await prisma.carts.findUnique({
      where: { sessionId: guestSessionId },
      include: { cart_items: true },
    });

    if (!guestCart || guestCart.cart_items.length === 0) {
      return { success: true, message: "No guest cart to merge" };
    }

    // Get or create user cart
    const userCart = await this.getOrCreateCart(userId);

    // Merge items
    for (const guestItem of guestCart.cart_items) {
      try {
        await this.addToCart({
          userId,
          productId: guestItem.productId,
          variantId: guestItem.variantId,
          quantity: guestItem.quantity,
          notes: guestItem.notes || undefined,
        });
      } catch (error) {
        console.error(`Failed to merge item ${guestItem.id}:`, error);
      }
    }

    // Delete guest cart
    await prisma.carts.delete({
      where: { id: guestCart.id },
    });

    return { success: true, message: "Guest cart merged successfully" };
  }

  // ==================== WISHLIST METHODS ====================

  /**
   * Get or create wishlist for user
   */
  async getOrCreateWishlist(userId: string, wishlistName?: string) {
    let wishlist = await prisma.wishlists.findFirst({
      where: { userId, isDefault: true },
    });

    if (!wishlist) {
      const now = new Date();
      wishlist = await prisma.wishlists.create({
        data: {
          id: uuidv4(),
          userId,
          name: wishlistName || "My Wishlist",
          isDefault: true,
          shareToken: uuidv4(),
          createdAt: now,
          updatedAt: now,
        },
      });
    }

    return wishlist;
  }

  /**
   * Add item to wishlist
   */
  async addToWishlist(data: AddToWishlistRequest) {
    // Get or create wishlist
    const wishlist = await this.getOrCreateWishlist(data.userId);

    // Check if product exists
    const product = await prisma.product.findUnique({
      where: { id: data.productId },
      include: {
        variants: {
          where: data.variantId ? { id: data.variantId } : undefined,
          take: 1,
        },
      },
    });

    if (!product) {
      throw new Error("Product not found");
    }

    // Get variant price
    const variant = data.variantId
      ? product.variants.find((v) => v.id === data.variantId)
      : product.variants[0];

    if (!variant) {
      throw new Error("Product variant not found");
    }

    // Check if item already exists
    const existingItem = await prisma.wishlist_items.findUnique({
      where: {
        wishlistId_productId_variantId: {
          wishlistId: wishlist.id,
          productId: data.productId,
          variantId: data.variantId || "",
        },
      },
    });

    if (existingItem) {
      throw new Error("Item already in wishlist");
    }

    // Create wishlist item
    const wishlistItem = await prisma.wishlist_items.create({
      data: {
        id: uuidv4(),
        wishlistId: wishlist.id,
        productId: data.productId,
        variantId: data.variantId,
        priority: data.priority || 0,
        notes: data.notes,
        priceWhenAdded: variant.price,
        notifyOnDiscount: data.notifyOnDiscount || false,
        notifyOnRestock: data.notifyOnRestock || false,
      },
    });

    return await prisma.wishlist_items.findUnique({
      where: { id: wishlistItem.id },
      include: {
        products: {
          select: {
            id: true,
            name: true,
            slug: true,
            vendorId: true,
          },
        },
        product_variants: {
          select: {
            id: true,
            sku: true,
            price: true,
            specialPrice: true,
            stock: true,
          },
        },
      },
    });
  }

  /**
   * Remove item from wishlist
   */
  async removeFromWishlist(wishlistItemId: string, userId: string) {
    const wishlistItem = await prisma.wishlist_items.findUnique({
      where: { id: wishlistItemId },
      include: { wishlists: true },
    });

    if (!wishlistItem) {
      throw new Error("Wishlist item not found");
    }

    if (wishlistItem.wishlists.userId !== userId) {
      throw new Error("Unauthorized");
    }

    await prisma.wishlist_items.delete({
      where: { id: wishlistItemId },
    });

    return { success: true, message: "Item removed from wishlist" };
  }

  /**
   * Get user's wishlist
   */
  async getWishlist(userId: string) {
    const wishlist = await prisma.wishlists.findFirst({
      where: { userId, isDefault: true },
      include: {
        wishlist_items: {
          include: {
            products: {
              select: {
                id: true,
                name: true,
                slug: true,

                vendorId: true,
              },
            },
            product_variants: {
              select: {
                id: true,
                sku: true,
                price: true,
                specialPrice: true,
                stock: true,
              },
            },
          },
          orderBy: [{ priority: "desc" }, { addedAt: "desc" }],
        },
      },
    });

    if (!wishlist) {
      return {
        totalItems: 0,
        items: [],
      };
    }

    // Enhance items with price changes
    const items = wishlist.wishlist_items.map((item) => {
      const currentPrice = item.product_variants?.price || 0;
      const priceChange = currentPrice - item.priceWhenAdded;
      const priceChangePercent = (priceChange / item.priceWhenAdded) * 100;

      return {
        ...item,
        currentPrice,
        priceChange,
        priceChangePercent: priceChangePercent.toFixed(2),
        isPriceDropped: priceChange < 0,
        isPriceIncreased: priceChange > 0,
        isInStock: (item.product_variants?.stock || 0) > 0,
      };
    });

    return {
      wishlistId: wishlist.id,
      wishlistName: wishlist.name,
      totalItems: items.length,
      items,
    };
  }

  /**
   * Move item from wishlist to cart
   */
  async moveToCart(
    wishlistItemId: string,
    userId: string,
    quantity: number = 1
  ) {
    // Get wishlist item
    const wishlistItem = await prisma.wishlist_items.findUnique({
      where: { id: wishlistItemId },
      include: {
        wishlists: true,
        product_variants: {
          select: {
            id: true,
            stock: true,
          },
        },
      },
    });

    if (!wishlistItem) {
      throw new Error("Wishlist item not found");
    }

    if (wishlistItem.wishlists.userId !== userId) {
      throw new Error("Unauthorized");
    }

    // Check stock
    const variantStock = wishlistItem.product_variants?.stock || 0;
    if (variantStock < quantity) {
      throw new Error("Insufficient stock");
    }

    // Add to cart
    const cartItem = await this.addToCart({
      userId,
      productId: wishlistItem.productId,
      variantId: wishlistItem.variantId || wishlistItem.product_variants!.id,
      quantity,
    });

    // Remove from wishlist
    await prisma.wishlist_items.delete({
      where: { id: wishlistItemId },
    });

    return {
      success: true,
      message: "Item moved to cart",
      cartItem,
    };
  }

  /**
   * Update wishlist item
   */
  async updateWishlistItem(
    wishlistItemId: string,
    userId: string,
    data: {
      priority?: number;
      notes?: string;
      notifyOnDiscount?: boolean;
      notifyOnRestock?: boolean;
    }
  ) {
    const wishlistItem = await prisma.wishlist_items.findUnique({
      where: { id: wishlistItemId },
      include: { wishlists: true },
    });

    if (!wishlistItem) {
      throw new Error("Wishlist item not found");
    }

    if (wishlistItem.wishlists.userId !== userId) {
      throw new Error("Unauthorized");
    }

    return await prisma.wishlist_items.update({
      where: { id: wishlistItemId },
      data,
    });
  }

  /**
   * Clear wishlist
   */
  async clearWishlist(userId: string) {
    const wishlist = await prisma.wishlists.findFirst({
      where: { userId, isDefault: true },
    });

    if (!wishlist) {
      throw new Error("Wishlist not found");
    }

    await prisma.wishlist_items.deleteMany({
      where: { wishlistId: wishlist.id },
    });

    return { success: true, message: "Wishlist cleared" };
  }
}

export default new CartWishService();
