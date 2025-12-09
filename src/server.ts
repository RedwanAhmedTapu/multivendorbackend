// server.ts
(BigInt.prototype as any).toJSON = function() {
  return this.toString();
};
import 'dotenv/config';

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
import shippingApi from "./routes/shippingProvider.routes.ts";
import TermsRoutes from "./routes/terms.routes.ts";
import { ChatSocket } from "./socket/chatSocket.ts";
import courierRoutes from "./routes/corierRoutes.ts";
import vendorstorage from "./routes/vendor-storage.routes.ts";
import filemanger from "./routes/vendor.folder.routes.ts";
import offerRoutes from "./routes/offers.routes.ts";
import employeeroutes from "./routes/employee.routes.ts";
import {storeLayoutRoutes} from "./routes/storeLayout.routes.ts";
import uploadRoutes from "./routes/upload.routes.ts"; 
import bulkproducttemplates from "./routes/bulkproductTemplate.routes.ts";
import categoryFilterRoutes from './routes/categoryFilterRoutes.ts';
import faqRoutes from './routes/faq.routes.ts'; 
import themeRoutes from './routes/theme.routes.ts';
import categoryTemplate from "./routes/category.template.routes.ts"

// Fix __dirname in ES Module
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = createServer(app);

const allowedOrigin =  "https://finixmart.com.bd" ;

// ✅ INCREASE PAYLOAD SIZE LIMIT - Add this before CORS
app.use(express.json({ limit: '50mb' })); // Increase from default 100kb to 50MB
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Express CORS
app.use(
  cors({
    origin: allowedOrigin,
    credentials: true,
  })
);
// Socket.io CORS
const io = new Server(server, {
  cors: {
    origin: allowedOrigin,
    credentials: true,
    methods: ["GET", "POST"],
  },
});

// Optional: rate limiting
// const limiter = rateLimit({
//   windowMs: 15 * 60 * 1000,
//   max: 100,
// });
// app.use(limiter);

// ✅ Static file serving (uploads)
app.use("/uploads", express.static(path.join(__dirname, "../uploads")));
app.use('/templates', express.static(path.join(__dirname, 'templates')));

// ✅ Routes
app.use("/api/sliders", sliderRoutes);
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
app.use("/api/shippingapi",shippingApi);
app.use("/api/courier", courierRoutes);
app.use("/api/terms", TermsRoutes);
app.use("/api/vendor-storage",vendorstorage);
app.use("/api/filemanager",filemanger);
app.use('/api/offers', offerRoutes);
app.use('/api/employees', employeeroutes);
app.use('/api/store-editor', storeLayoutRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/bulkproduct-templates', bulkproducttemplates);
app.use('/api/category-template', categoryTemplate);

app.use('/api/categories-filter', categoryFilterRoutes);
app.use('/api/faqs', faqRoutes);
app.use('/api/themes', themeRoutes);


// ✅ Socket.io handlers
new ChatSocket(io);

app.get("/", (_req, res) => res.send("E-commerce API running 🚀"));

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});

export default app;