// controllers/product.controller.public.ts
import type { Request, Response } from "express";
import { ProductCoreService } from "../services/product/product-core.service.ts";
import { ProductFilterService } from "../services/product/product-filter.service.ts";
import { ProductSearchService } from "../services/product/product-search.service.ts";
import { productFilterSchema } from "../validators/product.validator.ts";
import { ok, fail, handleError } from "../utils/response.ts";
import { console } from "inspector/promises";


/**
 * Frontend (FilterSidebar) URL এ যেভাবে filter পাঠায় সেটা comma-separated
 * flat query strings হিসেবে থাকে (ratings=4,5 / attributes=id:v1-v2,id2:v3
 * / brands=a,b), কিন্তু productFilterSchema typed/structured value আশা করে
 * (numbers, arrays, Record objects)। এই ফাংশন সেই রূপান্তরটা করে —
 * schema.parse() এর আগে কল করা আবশ্যক, নাহলে Zod ভ্যালিডেশন 422 দিয়ে ফেল করবে।
 */
function normalizeListingQuery(query: Record<string, any>) {
  const normalized: Record<string, any> = { ...query };

  // Numeric fields — query params সবসময় string আসে
  if (query.minPrice !== undefined) normalized.minPrice = Number(query.minPrice);
  if (query.maxPrice !== undefined) normalized.maxPrice = Number(query.maxPrice);
  if (query.limit !== undefined) normalized.limit = Number(query.limit);
  if (query.page !== undefined) normalized.page = Number(query.page);

  // ratings=4,5  ->  minRating (সবচেয়ে ছোট মান নেওয়া হচ্ছে, কারণ "4 & Up" +
  // "5 & Up" দুটো একসাথে বেছে নিলে বৃহত্তর সেট = ছোট threshold টাই আসল ফিল্টার)
  if (typeof query.ratings === "string" && query.ratings.trim()) {
    const ratingValues = query.ratings
      .split(",")
      .map((r: string) => Number(r))
      .filter((r: number) => !isNaN(r));
    if (ratingValues.length) normalized.minRating = Math.min(...ratingValues);
  }
  delete normalized.ratings; // schema-তে এই নামে field নেই

  // availability=inStock,onSale,newArrivals,freeShipping -> পৃথক boolean flags
  if (typeof query.availability === "string" && query.availability.trim()) {
    const flags = query.availability.split(",").map((s: string) => s.trim());
    if (flags.includes("inStock")) normalized.inStock = true;
    if (flags.includes("onSale")) normalized.onSale = true;
    if (flags.includes("newArrivals")) normalized.newArrival = true;
    if (flags.includes("freeShipping")) normalized.freeShipping = true;
  }
  delete normalized.availability; // schema-তে এই নামে field নেই

  // brands=id1,id2 -> brandIds array
  if (typeof query.brands === "string" && query.brands.trim()) {
    normalized.brandIds = query.brands.split(",").map((b: string) => b.trim()).filter(Boolean);
  }
  delete normalized.brands;

  // attributes=attrId:val1-val2,attrId2:val3 -> Record<string, string[]>
  // ✅ ফিক্স: FilterSidebar (frontend) URL এ key হিসেবে "attrs" পাঠায়, কিন্তু
  // এই ফাংশন আগে শুধু "attributes" নামে key খুঁজত। ফলে "attrs" কখনো ধরা
  // পড়তো না এবং normalized object-এ অচেনা/stray key হয়ে থেকে যেত, যেটা
  // productFilterSchema.parse() এ গিয়ে validation fail করাতো — তাই পুরো
  // request-ই ব্যর্থ হয়ে "Product not found" এর মতো ফলাফল দিত।
  const rawAttrs = query.attributes ?? query.attrs;
  if (typeof rawAttrs === "string" && rawAttrs.trim()) {
    const attrRecord: Record<string, string[]> = {};
    rawAttrs.split(",").forEach((pair: string) => {
      const [attrId, vals] = pair.split(":");
      if (attrId && vals) attrRecord[attrId] = vals.split("-").filter(Boolean);
    });
    normalized.attributes = attrRecord;
  }
  delete normalized.attrs; // schema-তে এই নামে field নেই, থেকে গেলে validation crash করবে

  return normalized;
}
export const PublicProductController = {
 // GET /api/products  — cursor-paginated listing
  async getAll(req: Request, res: Response) {
    try {
      const filters = productFilterSchema.parse(normalizeListingQuery(req.query));
      const { items, pagination } = await ProductFilterService.filterForPublic(filters);
      return ok(res, items, { pagination, message: "Products fetched" });
    } catch (error: any) {
       console.error("Zod validation error:", error?.errors ?? error);
      return handleError(res, error, "Failed to fetch products");
    }
  },

  // POST /api/products/filter — combined filters
  async filter(req: Request, res: Response) {
    try {
      const merged = { ...req.body, ...req.query };
      const filters = productFilterSchema.parse(normalizeListingQuery(merged));
      const { items, pagination } = await ProductFilterService.filterForPublic(filters);
      return ok(res, items, { pagination, message: "Filtered products fetched", meta: { filtersApplied: filters } });
    } catch (error: any) {
      return handleError(res, error, "Failed to filter products");
    }
  },

  // GET /api/products/search?q=...&mode=full
  // mode=suggest (default) -> bare {id,name,slug,rank} for autocomplete dropdowns
  // mode=full               -> card-shaped {image, price, vendor, avgRating, ...}
  //                             for a real "/search?q=..." results page
  async search(req: Request, res: Response) {
    try {
      const q = (req.query.q as string) || "";
      if (!q.trim()) return fail(res, "Search query 'q' is required", { status: 400 });
      const limit = req.query.limit ? Number(req.query.limit) : 20;
      const withCardData = req.query.mode === "full";
      const results = await ProductSearchService.search(q, { limit, onlyActive: true, withCardData });
      return ok(res, results, { message: "Search results", meta: { query: q, count: results.length } });
    } catch (error: any) {
      return handleError(res, error, "Failed to search products");
    }
  },

  // GET /api/products/featured
  async getFeatured(req: Request, res: Response) {
    try {
      const limit = req.query.limit ? Number(req.query.limit) : 10;
      const items = await ProductFilterService.featured(limit);
      return ok(res, items, { message: "Featured products" });
    } catch (error: any) {
      return handleError(res, error, "Failed to fetch featured products");
    }
  },

  // GET /api/products/new-arrivals
  async getNewArrivals(req: Request, res: Response) {
    try {
      const limit = req.query.limit ? Number(req.query.limit) : 10;
      const items = await ProductFilterService.newArrivals(limit);
      return ok(res, items, { message: "New arrivals" });
    } catch (error: any) {
      return handleError(res, error, "Failed to fetch new arrivals");
    }
  },

  // GET /api/products/trending
  async getTrending(req: Request, res: Response) {
    try {
      const limit = req.query.limit ? Number(req.query.limit) : 10;
      const items = await ProductFilterService.trending(limit);
      return ok(res, items, { message: "Trending products" });
    } catch (error: any) {
      return handleError(res, error, "Failed to fetch trending products");
    }
  },

  // GET /api/products/best-selling
  async getBestSelling(req: Request, res: Response) {
    try {
      const limit = req.query.limit ? Number(req.query.limit) : 10;
      const items = await ProductFilterService.bestSelling(limit);
      return ok(res, items, { message: "Best selling products" });
    } catch (error: any) {
      return handleError(res, error, "Failed to fetch best selling products");
    }
  },

  // GET /api/products/flash-sale
  async getFlashSale(req: Request, res: Response) {
    try {
      const limit = req.query.limit ? Number(req.query.limit) : 20;
      const items = await ProductFilterService.flashSale(limit);
      return ok(res, items, { message: "Flash sale products" });
    } catch (error: any) {
      return handleError(res, error, "Failed to fetch flash sale products");
    }
  },

  // GET /api/products/discounted
  async getDiscounted(req: Request, res: Response) {
    try {
      const limit = req.query.limit ? Number(req.query.limit) : 20;
      const items = await ProductFilterService.discounted(limit);
      return ok(res, items, { message: "Discounted products" });
    } catch (error: any) {
      return handleError(res, error, "Failed to fetch discounted products");
    }
  },

  // GET /api/products/:productId/related
  async getRelated(req: Request, res: Response) {
    try {
      const limit = req.query.limit ? Number(req.query.limit) : 10;
      const items = await ProductFilterService.related(req.params.productId, limit);
      return ok(res, items, { message: "Related products" });
    } catch (error: any) {
      return handleError(res, error, "Failed to fetch related products");
    }
  },

  // GET /api/products/:productId/similar
  async getSimilar(req: Request, res: Response) {
    try {
      const limit = req.query.limit ? Number(req.query.limit) : 10;
      const items = await ProductFilterService.similar(req.params.productId, limit);
      return ok(res, items, { message: "Similar products" });
    } catch (error: any) {
      return handleError(res, error, "Failed to fetch similar products");
    }
  },

  // GET /api/products/recently-viewed  (auth required)
  async getRecentlyViewed(req: any, res: Response) {
    try {
      const userId = req.user?.id;
      if (!userId) return fail(res, "Login required", { status: 401 });
      const limit = req.query.limit ? Number(req.query.limit) : 10;
      const items = await ProductFilterService.recentlyViewed(userId, limit);
      return ok(res, items, { message: "Recently viewed products" });
    } catch (error: any) {
      return handleError(res, error, "Failed to fetch recently viewed products");
    }
  },

  // GET /api/products/category/:categoryId
  async getByCategoryId(req: Request, res: Response) {
    try {
      const filters = productFilterSchema.parse({ categoryId: req.params.categoryId, ...req.query });
      const { items, pagination } = await ProductFilterService.filterForPublic(filters);
      return ok(res, items, { pagination, message: "Category products fetched" });
    } catch (error: any) {
      return handleError(res, error, "Failed to fetch category products");
    }
  },
// GET /api/products/category/slug/:categorySlug
async getByCategorySlug(req: Request, res: Response) {
  try {
    const filters = productFilterSchema.parse({ categorySlug: req.params.categorySlug, ...req.query });
    const { items, pagination } = await ProductFilterService.filterForPublic(filters);
    return ok(res, items, { pagination, message: "Category products fetched" });
  } catch (error: any) {
    return handleError(res, error, "Failed to fetch category products");
  }
},
  // GET /api/products/:slug — SEO detail page, fetched by slug not id
  async getBySlug(req: any, res: Response) {
    try {
      const product = await ProductCoreService.getDetailBySlug(req.params.slug, {
        viewerUserId: req.user?.id,
      });
      if (!product) return fail(res, "Product not found", { status: 404 });

      if (product.redirectedFrom) {
        res.set("X-Redirected-From", product.redirectedFrom);
      }
      return ok(res, product, { message: "Product fetched" });
    } catch (error: any) {
      return handleError(res, error, "Failed to fetch product");
    }
  },
};