// services/cartWish.service.ts
import { PrismaClient } from "@prisma/client";
import { v4 as uuidv4 } from "uuid";
import { buildCheckoutQuote } from "./order.service.ts";
import { effectivePrice } from "../modules/shared/pricing.ts";

const prisma = new PrismaClient();

/** This module's own Prisma client — exported only so tests can stub its delegates. */
export const cartWishDb = prisma;

/** The delivery preview's address is missing or not the customer's own (→ 404). */
export class AddressNotFoundError extends Error {
  readonly code = "ADDRESS_NOT_FOUND";
  constructor() {
    super("Delivery address not found");
    this.name = "AddressNotFoundError";
  }
}

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
  // ==================== STOCK / WEIGHT HELPERS ====================
  // NOTE: ProductVariant no longer carries a `stock` field — stock lives in
  // WarehouseStock (per warehouse/rack). "Available" = quantity - reserved - damaged,
  // summed across all warehouses that hold this variant.

  private async getAvailableStock(variantId: string): Promise<number> {
    const agg = await prisma.warehouseStock.aggregate({
      where: { variantId },
      _sum: { quantity: true, reservedQty: true, damagedQty: true },
    });
    const qty = agg._sum.quantity || 0;
    const reserved = agg._sum.reservedQty || 0;
    const damaged = agg._sum.damagedQty || 0;
    return Math.max(0, qty - reserved - damaged);
  }

  private async getAvailableStockMap(
    variantIds: string[]
  ): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    const uniqueIds = [...new Set(variantIds)];
    if (uniqueIds.length === 0) return map;

    uniqueIds.forEach((id) => map.set(id, 0));

    const rows = await prisma.warehouseStock.groupBy({
      by: ["variantId"],
      where: { variantId: { in: uniqueIds } },
      _sum: { quantity: true, reservedQty: true, damagedQty: true },
    });

    for (const row of rows) {
      const qty = row._sum.quantity || 0;
      const reserved = row._sum.reservedQty || 0;
      const damaged = row._sum.damagedQty || 0;
      map.set(row.variantId, Math.max(0, qty - reserved - damaged));
    }

    return map;
  }

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

    if (userId) {
      cart = await prisma.carts.findUnique({ where: { userId } });
    }

    if (!cart && sessionId) {
      cart = await prisma.carts.findUnique({ where: { sessionId } });
    }

    if (!cart) {
      cart = await prisma.carts.create({
        data: {
          userId: userId || null,
          sessionId: sessionId || uuidv4(),
          fingerprint,
          isGuest: !userId,
          lastActivityAt: now,
          expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        },
      });
    }

    if (userId && cart.isGuest) {
      cart = await prisma.carts.update({
        where: { id: cart.id },
        data: {
          userId,
          isGuest: false,
          updatedAt: now,
        },
      });
    }

    await prisma.carts.update({
      where: { id: cart.id },
      data: {
        lastActivityAt: now,
        updatedAt: now,
      },
    });

    return cart;
  }

  /**
   * Add item to cart
   */
  async addToCart(data: AddToCartRequest) {
    const cart = await this.getOrCreateCart(data.userId, data.sessionId);

    const variant = await prisma.productVariant.findUnique({
      where: { id: data.variantId },
      select: {
        id: true,
        productId: true,
        price: true,
        specialPrice: true,
        availability: true,
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

    if (variant.availability === false) {
      throw new Error("This product variant is currently unavailable");
    }

    // 1C-23: a variant without a valid positive price can never be a
    // legitimate cart line — block it at add time (the B15 price snapshot
    // is taken from variant.price right below, so it must be sane first).
    if (!(Number(variant.price) > 0)) {
      throw new Error(
        "This product variant has no valid price yet and cannot be added to the cart"
      );
    }
    const snapshot = effectivePrice(variant.price, variant.specialPrice);

    // Check stock availability via WarehouseStock (no more variant.stock)
    const availableStock = await this.getAvailableStock(data.variantId);
    if (availableStock < data.quantity) {
      throw new Error(
        `Insufficient stock. Available: ${availableStock}, Requested: ${data.quantity}`
      );
    }

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
      const newQuantity = existingItem.quantity + data.quantity;

      if (availableStock < newQuantity) {
        throw new Error(
          `Insufficient stock. Available: ${availableStock}, Total requested: ${newQuantity}`
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
      cartItem = await prisma.cart_items.create({
        data: {
          id: uuidv4(),
          cartId: cart.id,
          productId: data.productId,
          variantId: data.variantId,
          quantity: data.quantity,
          // Approved rule (modules/shared/pricing.ts): the line price is the
          // server-computed selling price; compareAtPrice is the regular price
          // only while a valid discount is active. Never a client value.
          price: snapshot.price.toNumber(),
          compareAtPrice: snapshot.compareAtPrice ? snapshot.compareAtPrice.toNumber() : null,
          notes: data.notes,
          isSelected: true,
          lastSelectedAt: new Date(),
        },
      });
    }

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
            availability: true,
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
    const cartItem = await prisma.cart_items.findUnique({
      where: { id: cartItemId },
      include: {
        carts: true,
        product_variants: {
          select: { id: true, availability: true },
        },
      },
    });

    if (!cartItem) {
      throw new Error("Cart item not found");
    }

    if (userId && cartItem.carts.userId !== userId) {
      throw new Error("Unauthorized");
    }
    if (sessionId && cartItem.carts.sessionId !== sessionId) {
      throw new Error("Unauthorized");
    }

    if (data.quantity !== undefined) {
      if (data.quantity <= 0) {
        throw new Error("Quantity must be greater than 0");
      }

      if (cartItem.product_variants.availability === false) {
        throw new Error("This product variant is currently unavailable");
      }

      const availableStock = await this.getAvailableStock(cartItem.variantId);
      if (availableStock < data.quantity) {
        throw new Error(`Insufficient stock. Available: ${availableStock}`);
      }
    }

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
            availability: true,
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
    const cartItem = await prisma.cart_items.findUnique({
      where: { id: cartItemId },
      include: { carts: true },
    });

    if (!cartItem) {
      throw new Error("Cart item not found");
    }

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
                // 1C-22: read-only display fields for the cart UI (vendor
                // group header + product image fallback). No logic change.
                vendor: { select: { storeName: true } },
                images: {
                  select: { url: true, altText: true },
                  orderBy: { sortOrder: "asc" },
                },
              },
            },
            product_variants: {
              select: {
                id: true,
                sku: true,
                price: true,
                specialPrice: true,
                availability: true,
                images: {
                  select: { url: true, altText: true },
                  orderBy: { sortOrder: "asc" },
                },
                // 1C-22: variant options (e.g. Color-Black) for the cart line
                attributes: {
                  select: {
                    attributeValue: {
                      select: { value: true, attribute: { select: { name: true } } },
                    },
                  },
                },
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

    // Batch-fetch real stock (no more variant.stock)
    const variantIds = cart.cart_items.map((item) => item.variantId);
    const stockMap = await this.getAvailableStockMap(variantIds);

    const items = cart.cart_items.map((item) => {
      const availableStock = stockMap.get(item.variantId) ?? 0;
      return {
        ...item,
        itemTotal: item.price * item.quantity,
        // Only a real discount saves money (lines snapshotted before the
        // selling-price fix stored the lower special price as compareAtPrice).
        savings:
          item.compareAtPrice != null && item.compareAtPrice > item.price
            ? (item.compareAtPrice - item.price) * item.quantity
            : 0,
        isInStock:
          availableStock >= item.quantity &&
          item.product_variants.availability !== false,
        availableStock,
      };
    });

    return {
      totalItems,
      selectedItems,
      subtotal,
      selectedSubtotal,
      items,
    };
  }

  /**
   * Phase 2 (H-3): the checkout preview IS the checkout quote — the same
   * computation placeOrder repeats inside its transaction (order.service
   * buildCheckoutQuote): current selling prices, the reservation plan
   * (default warehouse first, split across warehouses as needed) and the
   * per-warehouse delivery charges, plus the quoteHash the order must be
   * placed with. Read-only: no reservation, no cart change. Uses the cart's
   * selected lines (exactly what placeOrder uses); `selectedItemIds` and
   * `codEnabled` are accepted for compatibility but change no amount.
   */
  async calculateDeliveryFees(
    userId: string | undefined,
    _sessionId: string,
    userAddressId: string,
    _codEnabled: boolean = false,
    _selectedItemIds?: string[]
  ) {
    if (!userAddressId) {
      throw new Error("User address ID is required");
    }
    if (!userId) {
      throw new Error("Session ID or User ID is required");
    }

    // The address must be the customer's own (as at placement).
    const address = await prisma.userAddress.findFirst({
      where: { id: userAddressId, userId },
      select: { id: true, locationId: true },
    });
    if (!address) {
      throw new AddressNotFoundError();
    }

    const cart = await prisma.carts.findFirst({
      where: { userId },
      include: {
        cart_items: {
          where: { isSelected: true },
          select: { id: true, variantId: true, quantity: true, price: true },
        },
      },
    });
    if (!cart || cart.cart_items.length === 0) {
      throw new Error("No items found in cart");
    }

    const { quote } = await buildCheckoutQuote(prisma, {
      userAddressId,
      userLocationId: address.locationId,
      lines: cart.cart_items.map((l) => ({
        cartItemId: l.id,
        variantId: l.variantId,
        quantity: l.quantity,
        cartPrice: l.price,
      })),
    });
    return quote;
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

    const itemsByVendor = selectedItems.reduce((acc, item) => {
      const vendorId = item.products.vendorId;
      if (!acc[vendorId]) {
        acc[vendorId] = {
          vendorId,
          items: [],
          subtotal: 0,
        };
      }
      acc[vendorId].items.push(item);
      acc[vendorId].subtotal += item.itemTotal;
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
    const guestCart = await prisma.carts.findUnique({
      where: { sessionId: guestSessionId },
      include: { cart_items: true },
    });

    if (!guestCart || guestCart.cart_items.length === 0) {
      return { success: true, message: "No guest cart to merge" };
    }

    await this.getOrCreateCart(userId);

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

    await prisma.carts.delete({
      where: { id: guestCart.id },
    });

    return { success: true, message: "Guest cart merged successfully" };
  }

  // ==================== WISHLIST METHODS ====================

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
    const wishlist = await this.getOrCreateWishlist(data.userId);

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

    const variant = data.variantId
      ? product.variants.find((v) => v.id === data.variantId)
      : product.variants[0];

    if (!variant) {
      throw new Error("Product variant not found");
    }

    // variantId is nullable in the schema — use null, not "", so the
    // compound-unique lookup actually matches rows with no variant set.
    const normalizedVariantId = data.variantId ?? null;

    const existingItem = await prisma.wishlist_items.findFirst({
      where: {
        wishlistId: wishlist.id,
        productId: data.productId,
        variantId: normalizedVariantId,
      },
    });

    if (existingItem) {
      throw new Error("Item already in wishlist");
    }

    const wishlistItem = await prisma.wishlist_items.create({
      data: {
        id: uuidv4(),
        wishlistId: wishlist.id,
        productId: data.productId,
        variantId: normalizedVariantId,
        priority: data.priority || 0,
        notes: data.notes,
        priceWhenAdded: Number(variant.price),
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
            availability: true,
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
                availability: true,
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

    const variantIds = wishlist.wishlist_items
      .map((item) => item.variantId)
      .filter((id): id is string => !!id);
    const stockMap = await this.getAvailableStockMap(variantIds);

    const items = wishlist.wishlist_items.map((item) => {
      const currentPrice = item.product_variants
        ? Number(item.product_variants.price)
        : 0;
      const priceChange = currentPrice - item.priceWhenAdded;
      const priceChangePercent = item.priceWhenAdded
        ? (priceChange / item.priceWhenAdded) * 100
        : 0;

      const availableStock = item.variantId
        ? stockMap.get(item.variantId) ?? 0
        : 0;

      return {
        ...item,
        currentPrice,
        priceChange,
        priceChangePercent: priceChangePercent.toFixed(2),
        isPriceDropped: priceChange < 0,
        isPriceIncreased: priceChange > 0,
        isInStock: item.variantId
          ? availableStock > 0 && item.product_variants?.availability !== false
          : true,
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
    const wishlistItem = await prisma.wishlist_items.findUnique({
      where: { id: wishlistItemId },
      include: {
        wishlists: true,
        product_variants: {
          select: { id: true, availability: true },
        },
      },
    });

    if (!wishlistItem) {
      throw new Error("Wishlist item not found");
    }

    if (wishlistItem.wishlists.userId !== userId) {
      throw new Error("Unauthorized");
    }

    const variantId = wishlistItem.variantId || wishlistItem.product_variants?.id;
    if (!variantId) {
      throw new Error("No product variant associated with this wishlist item");
    }

    if (wishlistItem.product_variants?.availability === false) {
      throw new Error("This product variant is currently unavailable");
    }

    const availableStock = await this.getAvailableStock(variantId);
    if (availableStock < quantity) {
      throw new Error(`Insufficient stock. Available: ${availableStock}`);
    }

    const cartItem = await this.addToCart({
      userId,
      productId: wishlistItem.productId,
      variantId,
      quantity,
    });

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