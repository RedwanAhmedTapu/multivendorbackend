import multer from "multer";
import path from "path";
import fs from "fs";

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    let uploadPath = "uploads/general"; // default fallback
    const { type, role } = req.body;

    if (type === "slider") {
      if (role === "vendor") {
        uploadPath = "uploads/sliders/vendorImages";
      } else {
        uploadPath = "uploads/sliders/adminImages";
      }
    } else if (type === "product") {
      if (role === "vendor") {
        uploadPath = "uploads/products/vendorImages";
      } else {
        uploadPath = "uploads/products/adminImages";
      }
    }

    // Ensure directory exists
    fs.mkdirSync(uploadPath, { recursive: true });

    cb(null, uploadPath);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  },
});

export const upload = multer({ storage });
