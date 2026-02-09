// routes/cartWish.routes.ts - Updated for cleaner structure
import { Router } from 'express';
import cartWishController from '../controllers/cartWish.controller.ts';
import { authenticateUser } from '../middlewares/auth.middleware.ts';

const router = Router();

router.use(authenticateUser);

// ==================== CART ROUTES ====================

/**
 * @route   GET /api/cart-wish/cart
 * @desc    Get user's cart with all items
 */
router.get(
  '/cart',
  cartWishController.getCart.bind(cartWishController)
);

/**
 * @route   POST /api/cart-wish/cart/items
 * @desc    Add item to cart
 */
router.post(
  '/cart/items',
  cartWishController.addToCart.bind(cartWishController)
);

/**
 * @route   PATCH /api/cart-wish/cart/items/:itemId
 * @desc    Update cart item
 */
router.patch(
  '/cart/items/:itemId',
  cartWishController.updateCartItem.bind(cartWishController)
);

/**
 * @route   DELETE /api/cart-wish/cart/items/:itemId
 * @desc    Remove item from cart
 */
router.delete(
  '/cart/items/:itemId',
  cartWishController.removeFromCart.bind(cartWishController)
);

/**
 * @route   POST /api/cart-wish/cart/items/:itemId/toggle
 * @desc    Toggle item selection (check/uncheck)
 */
router.post(
  '/cart/items/:itemId/toggle',
  cartWishController.toggleItemSelection.bind(cartWishController)
);

/**
 * @route   POST /api/cart-wish/cart/toggle-all
 * @desc    Select or deselect all items in cart
 */
router.post(
  '/cart/toggle-all',
  cartWishController.toggleAllItems.bind(cartWishController)
);

/**
 * @route   DELETE /api/cart-wish/cart
 * @desc    Clear all items from cart
 */
router.delete(
  '/cart',
  cartWishController.clearCart.bind(cartWishController)
);

/**
 * @route   GET /api/cart-wish/cart/selected
 * @desc    Get selected items summary (for checkout)
 */
router.get(
  '/cart/selected',
  cartWishController.getSelectedItemsSummary.bind(cartWishController)
);

/**
 * @route   GET /api/cart-wish/cart/count
 * @desc    Get cart item count (for header badge)
 */
router.get(
  '/cart/count',
  cartWishController.getCartCount.bind(cartWishController)
);

/**
 * @route   POST /api/cart-wish/cart/merge
 * @desc    Merge guest cart into user cart (after login)
 */
router.post(
  '/cart/merge',
  cartWishController.mergeGuestCart.bind(cartWishController)
);

// ==================== WISHLIST ROUTES ====================

/**
 * @route   GET /api/cart-wish/wishlist
 * @desc    Get user's wishlist
 */
router.get(
  '/wishlist',
  cartWishController.getWishlist.bind(cartWishController)
);

/**
 * @route   POST /api/cart-wish/wishlist/items
 * @desc    Add item to wishlist
 */
router.post(
  '/wishlist/items',
  cartWishController.addToWishlist.bind(cartWishController)
);

/**
 * @route   DELETE /api/cart-wish/wishlist/items/:itemId
 * @desc    Remove item from wishlist
 */
router.delete(
  '/wishlist/items/:itemId',
  cartWishController.removeFromWishlist.bind(cartWishController)
);

/**
 * @route   PATCH /api/cart-wish/wishlist/items/:itemId
 * @desc    Update wishlist item
 */
router.patch(
  '/wishlist/items/:itemId',
  cartWishController.updateWishlistItem.bind(cartWishController)
);

/**
 * @route   POST /api/cart-wish/wishlist/items/:itemId/move-to-cart
 * @desc    Move item from wishlist to cart
 */
router.post(
  '/wishlist/items/:itemId/move-to-cart',
  cartWishController.moveToCart.bind(cartWishController)
);

/**
 * @route   DELETE /api/cart-wish/wishlist
 * @desc    Clear wishlist
 */
router.delete(
  '/wishlist',
  cartWishController.clearWishlist.bind(cartWishController)
);

/**
 * @route   GET /api/cart-wish/wishlist/count
 * @desc    Get wishlist item count (for header badge)
 */
router.get(
  '/wishlist/count',
  cartWishController.getWishlistCount.bind(cartWishController)
);

// routes/cartWish.routes.ts
// Replace the problematic route with these two routes:

/**
 * @route   GET /api/cart-wish/wishlist/check/:productId
 * @desc    Check if product is in wishlist (without variant)
 * @access  Private
 */
router.get(
  '/wishlist/check/:productId',
  // authenticate,
  cartWishController.checkProductInWishlist.bind(cartWishController)
);

/**
 * @route   GET /api/cart-wish/wishlist/check/:productId/:variantId
 * @desc    Check if product variant is in wishlist
 * @access  Private
 */
router.get(
  '/wishlist/check/:productId/:variantId',
  // authenticate,
  cartWishController.checkProductVariantInWishlist.bind(cartWishController)
);

// In your cart/checkout routes file (e.g., cart.routes.ts)

/**
 * @route   POST /api/cart/delivery-fees
 * @desc    Calculate delivery fees for cart items
 * @access  Public (session) or Authenticated
 */
router.post(
  '/delivery-fees',
  cartWishController.calculateDeliveryFees.bind(cartWishController)
);
export default router;