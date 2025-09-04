// server.ts
import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";

// Import routes
import authRoutes from "./routes/auth.routes.ts";
import productRoutes from "./routes/product.routes.ts";
import categoryRoutes from "./routes/category.routes.ts";
import attributeRoutes from "./routes/attribute.routes.ts";
import specificationRoutes from "./routes/specification.routes.ts";
import bulkImportRoutes from "./routes/bulkImport.routes.ts";
import sliderRoutes from "./routes/slider.routes.ts";

// Fix __dirname in ES Module
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(cors({ origin: "*" }));

// Serve uploaded images statically
app.use("/uploads", express.static(path.join(__dirname, "../uploads")));

// Routes
app.use("/sliders", sliderRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/products", productRoutes);
app.use("/api/categories", categoryRoutes);
app.use("/api/attributes", attributeRoutes);
app.use("/api/specifications", specificationRoutes);
app.use("/api/bulk-import-category", bulkImportRoutes);

app.get("/", (req, res) => res.send("E-commerce API running 🚀"));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

export default app;
