// config/cache.ts
import redisClient from "./redis.ts"; 

const DEFAULT_TTL_SECONDS = 60 * 5; // 5 minutes

export const cacheKeys = {
  productBySlug: (slug: string) => `product:slug:${slug}`,
  productById: (id: string) => `product:id:${id}`,
  categoryBySlug: (slug: string) => `category:slug:${slug}`,
  productListing: (hash: string) => `product:listing:${hash}`,
  productSearch: (hash: string) => `product:search:${hash}`,
  featured: (limit: number) => `product:featured:${limit}`,
  newArrivals: (limit: number) => `product:new-arrivals:${limit}`,
  trending: (limit: number) => `product:trending:${limit}`,
  bestSelling: (limit: number) => `product:best-selling:${limit}`,
  vendorStats: (vendorId: string) => `stats:vendor:${vendorId}`,
  adminStats: () => `stats:admin:global`,
  related: (productId: string) => `product:related:${productId}`,
};

export async function cacheGet<T>(key: string): Promise<T | null> {
  const raw = await redisClient.get(key);
  return raw ? (JSON.parse(raw) as T) : null;
}

export async function cacheSet(key: string, value: unknown, ttlSeconds = DEFAULT_TTL_SECONDS) {
  await redisClient.set(key, JSON.stringify(value), { EX: ttlSeconds });
}

/**
 * FIXED: node-redis v4 does NOT accept arrays for del(). 
 * It expects individual strings: del(key1, key2, key3)
 */
export async function cacheDel(...keys: (string | undefined | null)[]) {
  // 1. Strictly filter to only valid strings
  const validKeys = keys.filter((k): k is string => typeof k === 'string');
  
  // 2. Bail out if empty
  if (validKeys.length === 0) return;
  
  // 3. MUST use the spread operator (...) to pass them as individual arguments
  await redisClient.del(...validKeys);
}

/**
 * Invalidates every cache entry that could be stale after a product write
 */
export async function invalidateProductCache(params: {
  productId: string;
  slug?: string;
  vendorId?: string;
}) {
  const patterns = [
    cacheKeys.productById(params.productId),
    ...(params.slug ? [cacheKeys.productBySlug(params.slug)] : []),
    ...(params.vendorId ? [cacheKeys.vendorStats(params.vendorId)] : []),
    cacheKeys.adminStats(),
  ];
  
  // This is safe now because cacheDel spreads the array
  await cacheDel(...patterns);

  // Listing/search caches are keyed by a hash of filters
  const prefixes = [
    "product:listing:", 
    "product:search:", 
    "product:featured:", 
    "product:new-arrivals:", 
    "product:trending:", 
    "product:best-selling:"
  ];
  
  for (const prefix of prefixes) {
    for await (const key of redisClient.scanIterator({ MATCH: `${prefix}*`, COUNT: 100 })) {
      // Call redisClient.del directly with .toString() to be 100% immune to 
      // buffers/objects and avoid passing arrays completely.
      if (key) await redisClient.del(key.toString()); 
    }
  }
}

/** Public product caches built from many products at once (listings,
 *  search, discovery lists, related). */
export const PUBLIC_PRODUCT_LIST_PREFIXES = [
  "product:listing:",
  "product:search:",
  "product:featured:",
  "product:new-arrivals:",
  "product:trending:",
  "product:best-selling:",
  "product:related:",
];

/**
 * Phase 1 S3/P3: after a vendor's status changes (suspended, deactivated,
 * re-activated), drop every cached public view of its products — the
 * product slug/id keys of the given products plus all list/search caches.
 * node-redis v5: scanIterator yields key BATCHES (arrays) and DEL takes a
 * single key-or-array argument, so keys are always passed as one array.
 */
export async function invalidateVendorProductCaches(
  vendorId: string,
  products: { id: string; slug?: string | null }[],
) {
  const direct = [
    cacheKeys.vendorStats(vendorId),
    ...products.flatMap((p) => [
      cacheKeys.productById(p.id),
      ...(p.slug ? [cacheKeys.productBySlug(p.slug)] : []),
    ]),
  ];
  for (let i = 0; i < direct.length; i += 500) {
    await redisClient.del(direct.slice(i, i + 500));
  }

  for (const prefix of PUBLIC_PRODUCT_LIST_PREFIXES) {
    for await (const batch of redisClient.scanIterator({ MATCH: `${prefix}*`, COUNT: 100 })) {
      const keys = (Array.isArray(batch) ? batch : [batch]).map(String).filter(Boolean);
      if (keys.length > 0) await redisClient.del(keys);
    }
  }
}

/** Simple deterministic hash for building cache keys from filter objects. */
export function hashFilters(obj: Record<string, unknown>): string {
  const sorted = Object.keys(obj)
    .sort()
    .reduce((acc, k) => {
      if (obj[k] !== undefined) acc[k] = obj[k];
      return acc;
    }, {} as Record<string, unknown>);
  return Buffer.from(JSON.stringify(sorted)).toString("base64url");
}

export default redisClient;