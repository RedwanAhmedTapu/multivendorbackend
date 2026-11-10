// server.example.ts
//
// This is NOT a new server — it's the exact diff you add to your REAL
// server.ts, plus the CORS change. Everything else in server.ts stays
// untouched.

// ── 1. Add this import alongside your other route imports ──────
// import blogRoutes from "./modules/blog-module/routes/blog.routes.ts";

// ── 2. Add this app.use() alongside your other app.use("/api/...") lines ──
// app.use("/api/blog", blogRoutes);

// ── 3. CORS — blog.finixmart.com.bd is a DIFFERENT origin than your
// storefront, so your current single-origin cors() config needs to
// become an allow-list. Replace:
//
//   const allowedOrigin = process.env.FRONTEND_URL || "http://localhost:3000";
//   app.use(cors({ origin: allowedOrigin, credentials: true }));
//
// with:
//
//   const allowedOrigins = [
//     process.env.FRONTEND_URL || "http://localhost:3000",
//     process.env.BLOG_FRONTEND_URL || "http://localhost:3001",
//   ];
//   app.use(cors({
//     origin: (origin, callback) => {
//       if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
//       callback(new Error("Not allowed by CORS"));
//     },
//     credentials: true,
//   }));
//
// (Socket.io's `io` CORS block can stay as-is — the blog site never opens
// a socket connection, it only calls the REST endpoints above.)
