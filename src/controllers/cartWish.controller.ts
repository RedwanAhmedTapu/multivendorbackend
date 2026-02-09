// controllers/cartWish.controller.ts
import type { Request, Response, NextFunction } from 'express';
import cartWishService from '../services/cartWish.service.ts';

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

      const result = await cartWishService.removeFromCart(itemId, userId, sessionId);

      res.status(200).json(result);
    } catch (error: any) {
      next(error);
    }
  }
async calculateDeliveryFees(req: Request, res: Response, next: NextFunction) {
  try {
    // @ts-ignore - Assuming auth middleware adds user
    const userId = req.user?.id;
    const sessionId = req.sessionID || req.headers['x-session-id'] as string;
    
    const { 
      userAddressId, 
      selectedItemIds, 
      codEnabled = false 
    } = req.body;

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

    // This now works perfectly!
    const deliveryFees = await cartWishService.calculateDeliveryFees(
      userId,
      sessionId,
      userAddressId,
      codEnabled,
      selectedItemIds
    );

    res.status(200).json({
      success: true,
      message: 'Delivery fees calculated successfully',
      data: deliveryFees,
    });
  } catch (error: any) {
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