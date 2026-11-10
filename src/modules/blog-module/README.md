# Blog Module (Public / Admin / Employee)

Express + TypeScript + Prisma. Same Controller → Service → Repository shape
as `product-module`, mounted on your **existing finixmart.com.bd backend**
(one database, one API). `blog.finixmart.com.bd` is a separate Next.js
frontend (see the `finixmart-blog-site` deliverable) that talks to this
API over CORS — it has no server of its own.

## Folder structure

```
prisma/schema-additions.prisma   → fields/models to merge into schema.prisma
types/blog.types.ts              → request DTOs
validators/blog.validator.ts     → Zod schemas
repositories/blog.repository.ts  → shared Prisma select/include shapes
services/blog/
  blog-post.service.ts       list/get/create/update/delete + SEO + revisions
  blog-category.service.ts   category tree CRUD
  blog-nav.service.ts        two-layer dropdown nav CRUD + reorder
  blog-site.service.ts       logo/brand colors + dynamic footer builder
controllers/  blog.controller.public.ts / blog.controller.admin.ts
routes/       blog.routes.ts
utils/        response.ts, pagination.ts, slug.util.ts
server.example.ts
```

## Applying the schema changes

1. `prisma/schema-additions.prisma` adds fields to your **existing**
   `BlogPost` model (see the commented block at the top) and adds six new
   models: `BlogCategory`, `BlogPostReference`, `BlogPostRevision`,
   `BlogNavItem`, `BlogSiteSettings`, `BlogFooterSettings` (+ its two
   child models). It does **not** touch your storefront's
   `FooterSettings` — the blog gets its own footer since it's a
   different property with different content.
2. `npx prisma migrate dev --name blog-module-additions`
3. Seed one `BlogSiteSettings` row (logo, colors) and one
   `BlogFooterSettings` row with columns/elements — the public API 500s
   without them, since the blog frontend always renders a header/footer.

## What each request maps to

- **Two-layer dropdown navbar** (Discover, Fashion, Electronics, Beauty…
  each with children) → `BlogNavItem` self-relation, `GET /api/blog/nav`
  returns the tree, admin CRUD at `/api/blog/admin/nav`.
- **Logo swap / brand colors** → `BlogSiteSettings`, one row, editable at
  `PUT /api/blog/admin/site-settings`. `primaryColorHex` /
  `backgroundHex` / `textColorHex` are consumed by the frontend's design
  tokens (default: teal `#0F766E` / warm white `#FAF7F2` / gray
  `#374151` — no pink, per your instruction).
- **Content-from-scratch authoring, price comparisons, links to other
  sites** → `BlogPost.body` is rich HTML from your editor of choice;
  `BlogPostReference` gives you structured "compare with other sites /
  source" cards you can render as a table without parsing HTML.
- **Dynamic, admin/employee-manageable footer** →
  `BlogFooterSettings` → `BlogFooterColumn` → `BlogFooterElement`,
  full-replace upsert at `PUT /api/blog/admin/footer` (send the whole
  tree, it reconciles in one transaction).
- **SEO** — `metaTitle`/`metaDescription`/`ogImage`/`canonicalUrl` are
  inline on `BlogPost` (simpler than the storefront's separate
  `ProductSEO` model, since a blog post doesn't need OpenGraph
  width/height or hreflang overrides).

## Image uploads (Cloudflare R2 — key only, never the full domain)

`POST /api/blog/upload` uses your real pipeline:

1. `middlewares/up.middleware.ts` → `imageUpload("blog", "ADMIN")` buffers
   the file in memory (single file, field name `file`).
2. `lib/r2-admin-config.ts` → `generateFileKey("blog", file.originalname)`
   + `uploadToR2Admin({ file: file.buffer, key, contentType })` pushes it
   to Cloudflare R2.
3. The response returns `{ success, file: { url: <R2_KEY> } }` — same
   envelope as `storeEditorApi.uploadStoreImage`. **`file.url` here holds
   the raw R2 key, not a full URL** (e.g. `admin/blog/1699999999-cover.jpg`).

That key — and nothing else — is what gets saved into
`BlogPost.featuredImage`, `BlogPost.ogImage`, `BlogSiteSettings.logoUrl`,
`BlogSiteSettings.faviconUrl`, `BlogSiteSettings.defaultOgImage`, and
`BlogCategory.image`. Postgres never stores `https://pub-xxxx.r2.dev/...`
— only the key. All the validators for these fields were changed from
`z.string().url()` to plain `z.string()` for this reason.

**Turning a key into a renderable `<img src>` is a read-side concern:**
- Main-site **admin panel**: use whatever helper it already uses for
  product images (same pattern as `storeEditorApi`'s
  `"R2 key/path — needs a public-domain prefix"` comment).
- **blog.finixmart.com.bd frontend**: `finixmart-blog-site/lib/media.ts`
  → `resolveImageUrl(key)` prepends `NEXT_PUBLIC_R2_PUBLIC_DOMAIN`.

`BlogPostReference.url` is the one exception — that's a genuine external
link (a competitor's product page, a source article), so it keeps full
`z.string().url()` validation.

## API response envelope

Same as product-module:
```jsonc
{ "success": true, "message": "", "data": {} }
{ "success": false, "message": "", "errors": [] }
```

## What's stubbed

- `middlewares/auth.middleware.ts` / `upload.middleware.ts` are assumed
  to already exist in your project (product-module uses the same ones)
  — this module imports them, it doesn't redefine them.
- `config/prisma.ts` import path — adjust the relative path in
  `utils/slug.util.ts` and `repositories/blog.repository.ts` if your
  project layout differs from product-module's.
