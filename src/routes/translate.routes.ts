import { Router } from "express";
import axios from "axios";

const router = Router();

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID!;
const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN!;

router.post("/", async (req, res) => {
  const { text } = req.body;

  if (!text) {
    return res.status(400).json({
      error: "Text required",
    });
  }

  try {
  const response = await axios.post(
  `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai/run/@cf/meta/m2m100-1.2b`,
  {
    text: text,
    source_lang: "en",
    target_lang: "bn",
  },
  {
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
      "Content-Type": "application/json",
    },
  }
);

res.json({
  bn: response.data.result.translated_text,
});

    console.log(response.data);

    res.json({
      bn: response.data.result.translated_text,
    });
  } catch (err: any) {
    console.error(err.response?.data || err.message);

    res.status(500).json({
      error: "Translation failed",
    });
  }
});

export default router;