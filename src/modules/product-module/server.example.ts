// server.example.ts
// Minimal example of wiring this module into an Express app. Merge into
// your existing server entrypoint rather than running this file directly
// in production.
import express from "express";
import productRoutes from "./routes/product.routes.ts";
import { schedulePurgeJob } from "./jobs/purge-deleted-products.job.ts";

const app = express();
app.use(express.json());
app.use("/uploads", express.static("uploads"));

app.use("/api/products", productRoutes);

// Registers the daily 03:00 cron that permanently purges products
// soft-deleted 90+ days ago (see product-deletion.service.ts).
schedulePurgeJob();

const port = process.env.PORT || 4000;
app.listen(port, () => console.log(`Product module listening on :${port}`));
