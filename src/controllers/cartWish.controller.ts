// controllers/cartWish.controller.ts
import type { Request, Response, NextFunction } from 'express';
import cartWishService, { AddressNotFoundError } from '../services/cartWish.service.ts';
import { analyticsRecorder, trackAnalytics } from '../modules/analytics/analytics.recorder.ts';
import { analyticsContext } from '../modules/analytics/analytics.context.ts';

export class CartWishController {
  // ==================== CART ENDPOINTS ====================

  /**
   * Add item to cart
   * POST /api/cart/items
   */
  async addToCart(req: Request, res: Response, next: NextFunction) {
    try {
      // @ts-ignore - Assuming auth middleware adds user
      const userId = req.user?.id;
      const sessionId = req.sessionID || req.headers['x-session-id'] as string;
      
      const { productId, variantId, quantity, notes } = req.body;

      if (!productId || !variantId || !quantity) {
        return res.status(400).json({
          success: false,
          message: 'productId, variantId, and quantity are required',
        });
      }

      if (quantity <= 0) {
        return res.status(400).json({
          success: false,
          message: 'Quantity must be greater than 0',
        });
      }

      const cartItem = await cartWishService.addToCart({
        userId,
        sessionId,
        productId,
        variantId,
        quantity,
        notes,
      });

      // Business Advisor: recorded only after the cart was updated, from the
      // stored line (product / vendor from the database). Never awaited.
      const actx = analyticsContext(req as any);
      const added: any = cartItem;
      if (actx && added?.productId && added?.products?.vendorId) {
        trackAnalytics(analyticsRecorder.addToCart(
          actx,
          { productId: added.productId, variantId: added.variantId ?? null, vendorId: added.products.vendorId, quantity: Number(quantity) || null },
          req.body?.source,
        ));
      }

      res.status(201).json({
        success: true,
        message: 'Item added to cart',
        data: cartItem,
      });
    } catch (error: any) {
      next(error);
    }
  }

  /**
   * Get cart
   * GET /api/cart
   */
  async getCart(req: Request, res: Response, next: NextFunction) {
    try {
      // @ts-ignore
      const userId = req.user?.id;
      const sessionId = req.sessionID || req.headers['x-session-id'] as string;

      const cart = await cartWishService.getCart(userId, sessionId);

      res.status(200).json({
        success: true,
        data: cart,
      });
    } catch (error: any) {
      next(error);
    }
  }

  /**
   * Update cart item
   * PATCH /api/cart/items/:itemId
   */
  async updateCartItem(req: Request, res: Response, next: NextFunction) {
    try {
      // @ts-ignore
      const userId = req.user?.id;
      const sessionId = req.sessionID || req.headers['x-session-id'] as string;
      const { itemId } = req.params;
      const { quantity, isSelected, notes } = req.body;

      const cartItem = await cartWishService.updateCartItem(
        itemId,
        { quantity, isSelected, notes },
        userId,
        sessionId
      );

      // Business Advisor: only real quantity changes (not selection / notes).
      const updated: any = cartItem;
      const qctx = quantity !== undefined ? analyticsContext(req as any) : null;
      if (qctx && updated?.productId && updated?.products?.vendorId) {
        trackAnalytics(analyticsRecorder.quantityChanged(qctx, { productId: updated.productId, variantId: updated.variantId ?? null, vendorId: updated.products.vendorId, quantity: updated.quantity ?? null }));
      }

      res.status(200).json({
        success: true,
        message: 'Cart item updated',
        data: cartItem,
      });
    } catch (error: any) {
      next(error);
    }
  }

  /**
   * Remove item from cart
   * DELETE /api/cart/items/:itemId
   */
  async removeFromCart(req: Request, res: Response, next: NextFunction) {
    try {
      // @ts-ignore
      const userId = req.user?.id;
      const sessionId = req.sessionID || req.headers['x-session-id'] as string;
      const { itemId } = req.params;

      // Business Advisor: read the line first (it is gone afterwards); recorded only if the removal succeeds.
      const rctx = analyticsContext(req as any);
      const removedLine = rctx ? await analyticsRecorder.cartLine(itemId) : null;
      const result = await cartWishService.removeFromCart(itemId, userId, sessionId);
      if (rctx && removedLine) trackAnalytics(analyticsRecorder.removeFromCart(rctx, removedLine));

      res.status(200).json(result);
    } catch (error: any) {
      next(error);
    }
  }
async calculateDeliveryFees(req: Request, res: Response, next: NextFunction) {
  try {
    // @ts-ignore - Assuming auth middleware adds user
    const userId = req.user?.rawId || req.user?.id; // same identity placeOrder uses
    const sessionId = req.sessionID || req.headers['x-session-id'] as string;
    
    const userAddressId = (req.body?.userAddressId || req.query?.userAddressId) as string;
    let selectedItemIds = req.body?.selectedItemIds;
    if (!selectedItemIds && req.query?.selectedItemIds) {
      if (Array.isArray(req.query.selectedItemIds)) {
        selectedItemIds = req.query.selectedItemIds as string[];
      } else if (typeof req.query.selectedItemIds === 'string') {
        selectedItemIds = req.query.selectedItemIds.split(',').map((s: string) => s.trim()).filter(Boolean);
      }
    }
    const codRaw = req.body?.codEnabled ?? req.query?.codEnabled;
    const codEnabled = codRaw === true || codRaw === 'true' || codRaw === '1';

    // Validation
    if (!userAddressId) {
      return res.status(400).json({
        success: false,
        message: 'userAddressId is required',
      });
    }

    if (!sessionId && !userId) {
      return res.status(400).json({
        success: false,
        message: 'Session or user authentication required',
      });
    }

    const deliveryFees = await cartWishService.calculateDeliveryFees(
      userId,
      sessionId,
      userAddressId,
      codEnabled,
      selectedItemIds
    );

    const errorMessage = !deliveryFees.complete
      ? (deliveryFees.vendors.find((v: any) => v.error)?.error || 'Delivery quote incomplete — no courier available')
      : undefined;

    // Business Advisor: a quote that can't be fulfilled is a checkout failure for the vendors concerned.
    if (!deliveryFees.complete && userId) {
      const fctx = analyticsContext(req as any);
      const failing = deliveryFees.vendors.filter((v: any) => v.error).map((v: any) => v.vendorId).filter(Boolean);
      if (fctx) trackAnalytics(analyticsRecorder.checkoutFailed(fctx, userId, "SHIPPING_UNAVAILABLE", failing));
    }

    res.status(200).json({
      success: deliveryFees.complete,
      message: deliveryFees.complete
        ? 'Delivery fees calculated successfully'
        : errorMessage,
      data: deliveryFees,
    });
  } catch (error: any) {
    if (error instanceof AddressNotFoundError) {
      // @ts-ignore
      const failedUserId = req.user?.rawId || req.user?.id;
      const actx = failedUserId ? analyticsContext(req as any) : null;
      if (actx) trackAnalytics(analyticsRecorder.checkoutFailed(actx, failedUserId, "ADDRESS_INVALID"));
      return res.status(404).json({ success: false, code: error.code, message: error.message });
    }
    next(error);
  }
}
  /**
   * Toggle item selection (check/uncheck)
   * POST /api/cart/items/:itemId/toggle
   */
  async toggleItemSelection(req: Request, res: Response, next: NextFunction) {
    try {
      // @ts-ignore
      const userId = req.user?.id;
      const sessionId = req.sessionID || req.headers['x-session-id'] as string;
      const { itemId } = req.params;

      const cartItem = await cartWishService.toggleItemSelection(
        itemId,
        userId,
        sessionId
      );

      res.status(200).json({
        success: true,
        message: `Item ${cartItem.isSelected ? 'selected' : 'deselected'}`,
        data: cartItem,
      });
    } catch (error: any) {
      next(error);
    }
  }

  /**
   * Select/Deselect all items
   * POST /api/cart/toggle-all
   */
  async toggleAllItems(req: Request, res: Response, next: NextFunction) {
    try {
      // @ts-ignore
      const userId = req.user?.id;
      const sessionId = req.sessionID || req.headers['x-session-id'] as string;
      const { isSelected } = req.body;

      if (typeof isSelected !== 'boolean') {
        return res.status(400).json({
          success: false,
          message: 'isSelected must be a boolean',
        });
      }

      const result = await cartWishService.toggleAllItems(
        isSelected,
        userId,
        sessionId
      );

      res.status(200).json(result);
    } catch (error: any) {
      next(error);
    }
  }

  /**
   * Clear cart
   * DELETE /api/cart
   */
  async clearCart(req: Request, res: Response, next: NextFunction) {
    try {
      // @ts-ignore
      const userId = req.user?.id;
      const sessionId = req.sessionID || req.headers['x-session-id'] as string;

      const result = await cartWishService.clearCart(userId, sessionId);

      res.status(200).json(result);
    } catch (error: any) {
      next(error);
    }
  }

  /**
   * Get selected items summary (for checkout)
   * GET /api/cart/selected
   */
  async getSelectedItemsSummary(req: Request, res: Response, next: NextFunction) {
    try {
      // @ts-ignore
      const userId = req.user?.id;
      const sessionId = req.sessionID || req.headers['x-session-id'] as string;

      const summary = await cartWishService.getSelectedItemsSummary(
        userId,
        sessionId
      );

      res.status(200).json({
        success: true,
        data: summary,
      });
    } catch (error: any) {
      next(error);
    }
  }

  /**
   * Merge guest cart into user cart (after login)
   * POST /api/cart/merge
   */
  async mergeGuestCart(req: Request, res: Response, next: NextFunction) {
    try {
      // @ts-ignore
      const userId = req.user?.id;
      const { guestSessionId } = req.body;

      if (!userId) {
        return res.status(401).json({
          success: false,
          message: 'User not authenticated',
        });
      }

      if (!guestSessionId) {
        return res.status(400).json({
          success: false,
          message: 'guestSessionId is required',
        });
      }

      const result = await cartWishService.mergeGuestCart(userId, guestSessionId);

      res.status(200).json(result);
    } catch (error: any) {
      next(error);
    }
  }

  // ==================== WISHLIST ENDPOINTS ====================

  /**
   * Add item to wishlist
   * POST /api/wishlist/items
   */
  async addToWishlist(req: Request, res: Response, next: NextFunction) {

    try {
      // @ts-ignore
      const userId = req.user?.id;

      if (!userId) {
        return res.status(401).json({
          success: false,
          message: 'Authentication required',
        });
      }

      const {
        productId,
        variantId,
        priority,
        notes,
        notifyOnDiscount,
        notifyOnRestock,
      } = req.body;

      if (!productId) {
        return res.status(400).json({
          success: false,
          message: 'productId is required',
        });
      }

      const wishlistItem = await cartWishService.addToWishlist({
        userId,
        productId,
        variantId,
        priority,
        notes,
        notifyOnDiscount,
        notifyOnRestock,
      });

      res.status(201).json({
        success: true,
        message: 'Item added to wishlist',
        data: wishlistItem,
      });
    } catch (error: any) {
      next(error);
    }
  }

  /**
   * Get wishlist
   * GET /api/wishlist
   */
  async getWishlist(req: Request, res: Response, next: NextFunction) {
    console.log(req.user)
    try {
      // @ts-ignore
      const userId = req.user?.id;

      if (!userId) {
        return res.status(401).json({
          success: false,
          message: 'Authentication required',
        });
      }

      const wishlist = await cartWishService.getWishlist(userId);

      res.status(200).json({
        success: true,
        data: wishlist,
      });
    } catch (error: any) {
      next(error);
    }
  }

  /**
   * Remove item from wishlist
   * DELETE /api/wishlist/items/:itemId
   */
  async removeFromWishlist(req: Request, res: Response, next: NextFunction) {
    try {
      // @ts-ignore
      const userId = req.user?.id;
      const { itemId } = req.params;

      if (!userId) {
        return res.status(401).json({
          success: false,
          message: 'Authentication required',
        });
      }

      const result = await cartWishService.removeFromWishlist(itemId, userId);

      res.status(200).json(result);
    } catch (error: any) {
      next(error);
    }
  }

  /**
   * Update wishlist item
   * PATCH /api/wishlist/items/:itemId
   */
  async updateWishlistItem(req: Request, res: Response, next: NextFunction) {
    try {
      // @ts-ignore
      const userId = req.user?.id;
      const { itemId } = req.params;
      const { priority, notes, notifyOnDiscount, notifyOnRestock } = req.body;

      if (!userId) {
        return res.status(401).json({
          success: false,
          message: 'Authentication required',
        });
      }

      const wishlistItem = await cartWishService.updateWishlistItem(
        itemId,
        userId,
        { priority, notes, notifyOnDiscount, notifyOnRestock }
      );

      res.status(200).json({
        success: true,
        message: 'Wishlist item updated',
        data: wishlistItem,
      });
    } catch (error: any) {
      next(error);
    }
  }

  /**
   * Move item from wishlist to cart
   * POST /api/wishlist/items/:itemId/move-to-cart
   */
  async moveToCart(req: Request, res: Response, next: NextFunction) {
    try {
      // @ts-ignore
      const userId = req.user?.id;
      const { itemId } = req.params;
      const { quantity = 1 } = req.body;

      if (!userId) {
        return res.status(401).json({
          success: false,
          message: 'Authentication required',
        });
      }

      const result = await cartWishService.moveToCart(itemId, userId, quantity);

      res.status(200).json(result);
    } catch (error: any) {
      next(error);
    }
  }

  /**
   * Clear wishlist
   * DELETE /api/wishlist
   */
  async clearWishlist(req: Request, res: Response, next: NextFunction) {
    try {
      // @ts-ignore
      const userId = req.user?.id;

      if (!userId) {
        return res.status(401).json({
          success: false,
          message: 'Authentication required',
        });
      }

      const result = await cartWishService.clearWishlist(userId);

      res.status(200).json(result);
    } catch (error: any) {
      next(error);
    }
  }

  // ==================== UTILITY ENDPOINTS ====================

  /**
   * Get cart count (for header badge)
   * GET /api/cart/count
   */
  async getCartCount(req: Request, res: Response, next: NextFunction) {
    try {
      // @ts-ignore
      const userId = req.user?.id;
      const sessionId = req.sessionID || req.headers['x-session-id'] as string;

      const cart = await cartWishService.getCart(userId, sessionId);

      res.status(200).json({
        success: true,
        data: {
          totalItems: cart.totalItems,
          selectedItems: cart.selectedItems,
        },
      });
    } catch (error: any) {
      next(error);
    }
  }

  /**
   * Get wishlist count (for header badge)
   * GET /api/wishlist/count
   */
  async getWishlistCount(req: Request, res: Response, next: NextFunction) {
    try {
      // @ts-ignore
      const userId = req.user?.id;

      if (!userId) {
        return res.status(200).json({
          success: true,
          data: { count: 0 },
        });
      }

      const wishlist = await cartWishService.getWishlist(userId);

      res.status(200).json({
        success: true,
        data: {
          count: wishlist.totalItems,
        },
      });
    } catch (error: any) {
      next(error);
    }
    
  }
  // controllers/cartWish.controller.ts
// Add this method
async checkProductInWishlist(req: Request, res: Response, next: NextFunction) {
  try {
    // @ts-ignore
    const userId = req.user?.id;
    const { productId } = req.params;

    // if (!userId) {
    //   return res.status(401).json({
    //     success: false,
    //     message: 'Authentication required',
    //   });
    // }

    const wishlist = await cartWishService.getWishlist(userId);
    const item = wishlist.items.find(
      (item) => item.productId === productId
    );

    res.status(200).json({
      success: true,
      data: {
        inWishlist: !!item,
        itemId: item?.id,
      },
    });
  } catch (error: any) {
    next(error);
  }
}

// And this method for variant check
async checkProductVariantInWishlist(req: Request, res: Response, next: NextFunction) {
  try {
    // @ts-ignore
    const userId = req.user?.id;
    const { productId, variantId } = req.params;

    // if (!userId) {
    //   return res.status(401).json({
    //     success: false,
    //     message: 'Authentication required',
    //   });
    // }

    const wishlist = await cartWishService.getWishlist(userId);
    const item = wishlist.items.find(
      (item) => item.productId === productId && item.variantId === variantId
    );

    res.status(200).json({
      success: true,
      data: {
        inWishlist: !!item,
        itemId: item?.id,
      },
    });
  } catch (error: any) {
    next(error);
  }
}
  
}

export default new CartWishController();