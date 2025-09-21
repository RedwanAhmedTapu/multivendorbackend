// server.ts
import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import rateLimit from "express-rate-limit";
import { createServer } from "http";
import { Server } from "socket.io";

// Import routes
import authRoutes from "./routes/auth.routes.ts";
import productRoutes from "./routes/product.routes.ts";
import categoryRoutes from "./routes/category.routes.ts";
import attributeRoutes from "./routes/attribute.routes.ts";
import specificationRoutes from "./routes/specification.routes.ts";
import bulkImportRoutes from "./routes/bulkImport.routes.ts";
import sliderRoutes from "./routes/slider.routes.ts";
import vendorManagementRoutes from "./routes/vendor.routes.ts";
import customerRoutes from "./routes/customer.routes.ts";
import orderRoutes from "./routes/order.routes.ts";
import payoutRoutes from "./routes/payout.routes.ts";
import chatRoutes from "./routes/chat.routes.ts";
import TermsRoutes from "./routes/terms.routes.ts";
import { ChatSocket } from "./socket/chatSocket.ts";

// Fix __dirname in ES Module
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = createServer(app);

// ✅ Socket.io setup
const io = new Server(server, {
  cors: {
    origin: process.env.BASE_URL || "http://localhost:3000",
    credentials: true,
    methods: ["GET", "POST"],
  },
});

// ✅ Express middlewares
app.use(express.json({ limit: "10mb" }));
app.use(
  cors({
    origin: process.env.BASE_URL || "http://localhost:3000",
    credentials: true,
  })
);

// Optional: rate limiting
// const limiter = rateLimit({
//   windowMs: 15 * 60 * 1000,
//   max: 100,
// });
// app.use(limiter);

// ✅ Static file serving (uploads)
app.use("/uploads", express.static(path.join(__dirname, "../uploads")));

// ✅ Routes
app.use("/sliders", sliderRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/products", productRoutes);
app.use("/api/categories", categoryRoutes);
app.use("/api/attributes", attributeRoutes);
app.use("/api/specifications", specificationRoutes);
app.use("/api/bulk-import-category", bulkImportRoutes);
app.use("/api/vendormanagement", vendorManagementRoutes);
app.use("/api/customermanagement", customerRoutes);
app.use("/api/order", orderRoutes);
app.use("/api/payout", payoutRoutes);
app.use("/api/chat", chatRoutes);
app.use("/api/terms", TermsRoutes);


// ✅ Socket.io handlers
new ChatSocket(io);

app.get("/", (_req, res) => res.send("E-commerce API running 🚀"));

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});

export default app;
