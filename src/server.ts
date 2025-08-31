// server.ts
import express from "express";
import cors from "cors";

// Import routes
import productRoutes from "./routes/product.routes.ts";
import categoryRoutes from "./routes/category.routes.ts";
import attributeRoutes from "./routes/attribute.routes.ts";
import specificationRoutes from "./routes/specification.routes.ts";
import bulkImportRoutes from "./routes/bulkImport.routes.ts";   

const app = express();
app.use(express.json());
app.use(cors({ origin: "*" }));

// Routes
app.use("/api/products", productRoutes);
app.use("/api/categories", categoryRoutes);
app.use("/api/attributes", attributeRoutes);
app.use("/api/specifications", specificationRoutes);
app.use("/api/bulk-import-category",bulkImportRoutes );

app.get("/", (req, res) => res.send("E-commerce API running 🚀"));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

export default app;