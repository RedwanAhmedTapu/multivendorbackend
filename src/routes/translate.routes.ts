import { Router } from "express";
import axios from "axios";
const router = Router();

router.post("/", async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: "Text required" });

  try {
    const response = await axios.post(
      "https://libretranslate.com/translate", 
      {
        q: text,
        source: "en",
        target: "bn",
        format: "text",
        api_key: "" // optional for public endpoint
      },
      {
        headers: { "Content-Type": "application/json" },
      }
    );

    console.log("Translation response:", response.data);
    res.json({ bn: response.data.translatedText });
  } catch (err: any) {
    console.error("Translation Error:", err.response?.data || err.message);
    res.status(500).json({ error: "Translation failed" });
  }
});

export default router;
