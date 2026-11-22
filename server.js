const express = require("express");
const { Pool } = require("pg");
const crypto = require("crypto");
const cloudinary = require("cloudinary").v2;
const multer = require("multer");

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }
});
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});
const app = express();
app.use(express.json());
app.use(express.text({ type: ["text/plain", "application/json"] }));

app.use((req, res, next) => {
  if (typeof req.body === "string") {
    try {
      req.body = JSON.parse(req.body);
    } catch (error) {
      console.error("JSON parsing error:", error);
    }
  }
  next();
});
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const APP_ID = process.env.APP_ID;
const APP_SECRET = process.env.APP_SECRET;
const REDIRECT_URI = process.env.OAUTH_REDIRECT_URI;
const FB_CONFIG_ID = process.env.FB_CONFIG_ID;

const API_VERSION = "v27.0";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 10000
});

let PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN || "";
const loginStates = new Map();

// DATABASE INITIALIZATION
async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS facebook_page (
      id INTEGER PRIMARY KEY,
      page_id TEXT NOT NULL,
      page_name TEXT NOT NULL,
      page_access_token TEXT NOT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  const result = await pool.query(
    "SELECT page_access_token FROM facebook_page WHERE id = 1"
  );

  if (result.rows.length > 0) {
    PAGE_ACCESS_TOKEN = result.rows[0].page_access_token;
    console.log("Facebook Page token loaded from database.");
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS products (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      price NUMERIC NOT NULL,
      stock INTEGER NOT NULL DEFAULT 0,
      description TEXT,
      image_url TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  console.log("Products table ready.");  console.log("Database connected successfully.");
}

// SAVE FACEBOOK PAGE
async function saveFacebookPage(page) {
  await pool.query(
    `INSERT INTO facebook_page
      (id, page_id, page_name, page_access_token, updated_at)
     VALUES (1, $1, $2, $3, CURRENT_TIMESTAMP)
     ON CONFLICT (id)
     DO UPDATE SET
       page_id = EXCLUDED.page_id,
       page_name = EXCLUDED.page_name,
       page_access_token = EXCLUDED.page_access_token,
       updated_at = CURRENT_TIMESTAMP`,
    [page.id, page.name, page.access_token]
  );

  PAGE_ACCESS_TOKEN = page.access_token;
}

// ADD PRODUCT
app.post("/api/products", async (req, res) => {
  try {
    const { name, price, stock, description, image_url } = req.body;

    if (!name || price === undefined) {
      return res.status(400).json({
        success: false,
        message: "Nom et prix obligatoires."
      });
    }

    const result = await pool.query(
      `INSERT INTO products
       (name, price, stock, description, image_url)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [name, price, stock || 0, description || "", image_url || ""]
    );

    res.json({
      success: true,
      product: result.rows[0]
    });

  } catch (error) {
    console.error("Add product error:", error);
    res.status(500).json({
      success: false,
      message: "Erreur lors de l'enregistrement du produit."
    });
  }
});// HOME
app.get("/", (req, res) => {
  res.send("ONE STORE AI Backend is running!");
});

// FACEBOOK LOGIN
app.get("/auth/facebook", (req, res) => {
  if (!APP_ID || !REDIRECT_URI || !FB_CONFIG_ID) {
    return res.status(500).send("Facebook configuration missing.");
  }

  const state = crypto.randomBytes(16).toString("hex");
  loginStates.set(state, Date.now());

  const loginUrl = new URL(
    `https://www.facebook.com/${API_VERSION}/dialog/oauth`
  );

  loginUrl.searchParams.set("client_id", APP_ID);
  loginUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  loginUrl.searchParams.set("config_id", FB_CONFIG_ID);
  loginUrl.searchParams.set("response_type", "code");
  loginUrl.searchParams.set("state", state);

  res.redirect(loginUrl.toString());
});

// FACEBOOK CALLBACK
app.get("/auth/facebook/callback", async (req, res) => {
  try {
    const { code, state, error } = req.query;

    if (error) {
      return res.status(400).send("Facebook login cancelled or denied.");
    }

    const stateTime = loginStates.get(state);

    if (!code || !stateTime || Date.now() - stateTime > 600000) {
      return res.status(400).send("Invalid or expired login request.");
    }

    loginStates.delete(state);

    const tokenUrl = new URL(
      `https://graph.facebook.com/${API_VERSION}/oauth/access_token`
    );

    tokenUrl.searchParams.set("client_id", APP_ID);
    tokenUrl.searchParams.set("client_secret", APP_SECRET);
    tokenUrl.searchParams.set("redirect_uri", REDIRECT_URI);
    tokenUrl.searchParams.set("code", code);

    const tokenResponse = await fetch(tokenUrl);
    const tokenData = await tokenResponse.json();

    if (!tokenResponse.ok || !tokenData.access_token) {
      console.error("Token error:", tokenData);
      return res.status(400).send("Unable to get Facebook access token.");
    }

    const pagesUrl = new URL(
      `https://graph.facebook.com/${API_VERSION}/me/accounts`
    );

    pagesUrl.searchParams.set("fields", "id,name,access_token");
    pagesUrl.searchParams.set("access_token", tokenData.access_token);

    const pagesResponse = await fetch(pagesUrl);
    const pagesData = await pagesResponse.json();

    if (!pagesResponse.ok || !pagesData.data || pagesData.data.length === 0) {
      console.error("Pages error:", pagesData);
      return res.status(400).send("No Facebook Page found or permission denied.");
    }

    const page = pagesData.data[0];

    await saveFacebookPage(page);

    console.log("Facebook Page saved:", page.name, page.id);

    res.send(`
      <h2>ONE STORE AI</h2>
      <p>Connexion Facebook réussie !</p>
      <p>Page connectée : ${page.name.replace(/[&<>"']/g, "")}</p>
      <p>Page Access Token enregistré dans la base de données.</p>
      <p>Vous pouvez retourner dans votre application.</p>
    `);

  } catch (error) {
    console.error("Facebook login error:", error);
    res.status(500).send("Facebook connection error.");
  }
});

// WEBHOOK VERIFICATION
app.get("/webhook", (req, res) => {
  if (
    req.query["hub.mode"] === "subscribe" &&
    req.query["hub.verify_token"] === VERIFY_TOKEN
  ) {
    return res.send(req.query["hub.challenge"]);
  }

  res.sendStatus(403);
});

// SEND MESSENGER MESSAGE
async function sendMessage(senderId, message) {
  if (!PAGE_ACCESS_TOKEN) {
    console.error("Page access token missing.");
    return;
  }

  const url =
    `https://graph.facebook.com/${API_VERSION}/me/messages?access_token=` +
    encodeURIComponent(PAGE_ACCESS_TOKEN);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      recipient: { id: senderId },
      messaging_type: "RESPONSE",
      message: { text: message }
    })
  });

  const result = await response.json();
  console.log("Messenger response:", result);
}

// WEBHOOK MESSAGES
app.post("/webhook", (req, res) => {
  res.sendStatus(200);

  if (req.body.object !== "page") return;

  for (const entry of req.body.entry || []) {
    for (const event of entry.messaging || []) {
      if (!event.message || event.message.is_echo) continue;

      const senderId = event.sender?.id;
      const receivedText = event.message.text;

      if (!senderId || !receivedText) continue;

      sendMessage(
        senderId,
        "Salama 😊 Tongasoa eto amin'ny ONE STORE! Misaotra amin'ny hafatrao. Inona no fanampiana ilainao?"
      ).catch(error => {
        console.error("Messenger error:", error);
      });
    }
  }
});

// START SERVER
const PORT = process.env.PORT || 3000;

initDatabase()
  .then(() => {
    app.get("/api/products", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM products ORDER BY id DESC"
    );
    res.json(result.rows);
  } catch (error) {
    console.error("Get products error:", error);
    res.status(500).json({ error: "Database error" });
  }
});app.post("/api/upload", express.raw({ type: "*/*", limit: "5mb" }), (req, res) => {
  if (!req.body || !req.body.length) {
    return res.status(400).json({ success: false, message: "Aucune image reçue." });
  }

  const stream = cloudinary.uploader.upload_stream(
    { folder: "one-store-ai" },
    (error, result) => {
      if (error) {
        console.error("Cloudinary upload error:", error);
        return res.status(500).json({ success: false });
      }

      res.json({
        success: true,
        image_url: result.secure_url
      });
    }
  );

  stream.end(req.body);
});app.listen(PORT, () => {
      console.log("ONE STORE AI running on port " + PORT);
    });
  })
  .catch(error => {
    console.error("Database initialization failed:", error);
    process.exit(1);
  });
