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

// CUSTOMER ORDER SESSIONS
const orderSessions = new Map();

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
await pool.query(`
  CREATE TABLE IF NOT EXISTS orders (
    id SERIAL PRIMARY KEY,
    sender_id TEXT NOT NULL,
    product_id INTEGER REFERENCES products(id),
    product_name TEXT NOT NULL,
    unit_price INTEGER NOT NULL,
    quantity INTEGER NOT NULL,
    customer_name TEXT NOT NULL,
    phone TEXT NOT NULL,
    total_price INTEGER NOT NULL,
    status TEXT DEFAULT 'nouvelle',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )
`);

console.log("Orders table ready.");
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
  try {console.log("ADD PRODUCT BODY:", req.body);
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
// GET PRODUCTS FROM DATABASE
async function getProducts() {
  const result = await pool.query(
    "SELECT id, name, price, stock, description FROM products ORDER BY id DESC"
  );

  return result.rows;
}

// BUILD PRODUCTS REPLY
function buildProductsReply(products, language) {
  if (products.length === 0) {
    return language === "fr"
      ? "Désolé, aucun produit n'est disponible pour le moment."
      : "Miala tsiny, mbola tsy misy produit disponible amin'izao fotoana izao.";
  }

  const productList = products.map(product =>
    `• ${product.id}. ${product.name} - ${product.price} Ar (Stock: ${product.stock})`
  ).join("\n");

  if (language === "fr") {
    return "Voici nos produits disponibles 😊\n\n" + productList +
      "\n\nEnvoyez le numéro du produit qui vous intéresse.";
  }

  return "Ireto ny produits misy eto aminay 😊\n\n" + productList +
    "\n\nAlefaso ny numéro an'ilay produit tianao hovidiana.";
}

// DETECT CUSTOMER LANGUAGE
function detectLanguage(text) {
  const message = text.toLowerCase();

  const malagasyWords = [
    "manao ahoana", "mila", "misy", "ohatrinona",
    "vidiny", "aiza", "azafady", "mba", "afaka",
    "ve", "firy", "hividy", "commande"
  ];

  const frenchWords = [
    "bonjour", "bonsoir", "combien", "prix",
    "disponible", "avez-vous", "je veux",
    "commander", "merci", "livraison",
    "est-ce", "produit"
  ];

  const mgScore = malagasyWords.filter(word =>
    message.includes(word)
  ).length;

  const frScore = frenchWords.filter(word =>
    message.includes(word)
  ).length;

  return frScore > mgScore ? "fr" : "mg";
    }
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

// CREATE CUSTOMER ORDER
app.post("/api/orders", async (req, res) => {
  try {
    const {
      sender_id,
      product_id,
      product_name,
      unit_price,
      quantity,
      customer_name,
      phone
    } = req.body;

    if (
      !sender_id || !product_id || !product_name ||
      !unit_price || !quantity || !customer_name || !phone
    ) {
      return res.status(400).json({
        success: false,
        message: "Informations de commande incomplètes."
      });
    }

    const total_price = Number(unit_price) * Number(quantity);

    const result = await pool.query(
      `INSERT INTO orders
      (sender_id, product_id, product_name, unit_price,
       quantity, customer_name, phone, total_price)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING *`,
      [
        sender_id, product_id, product_name,
        unit_price, quantity, customer_name,
        phone, total_price
      ]
    );

    res.json({
      success: true,
      order: result.rows[0]
    });

  } catch (error) {
    console.error("Create order error:", error);
    res.status(500).json({
      success: false,
      message: "Erreur lors de l'enregistrement."
    });
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

// WEBHOOK MESSAGES - AUTOMATIC ORDER SYSTEM
app.post("/webhook", (req, res) => {
  res.sendStatus(200);

  if (req.body.object !== "page") return;

  for (const entry of req.body.entry || []) {
    for (const event of entry.messaging || []) {
      if (!event.message || event.message.is_echo) continue;

      const senderId = event.sender?.id;
      const receivedText = event.message.text;

      if (!senderId || !receivedText) continue;

      (async () => {
        try {
          const language = detectLanguage(receivedText);
          const message = receivedText.trim();
          const lowerMessage = message.toLowerCase();

          // CANCEL ORDER
          if (
            ["cancel", "annuler", "foana"].includes(lowerMessage)
          ) {
            orderSessions.delete(senderId);
            await sendMessage(
              senderId,
              "Commande annulée. Afaka manomboka indray ianao."
            );
            return;
          }

          // CHECK EXISTING ORDER SESSION
          const session = orderSessions.get(senderId);

          // STEP 1: SELECT PRODUCT
          if (session && session.step === "quantity") {
            const quantity = Number(message);

            if (
              !Number.isInteger(quantity) ||
              quantity <= 0
            ) {
              await sendMessage(senderId, "Ampidiro ny quantité marina.");
              return;
            }

            if (quantity > session.product.stock) {
              await sendMessage(
                senderId,
                `Stock disponible: ${session.product.stock}. Ampidiro quantité mety.`
              );
              return;
            }

            session.quantity = quantity;
            session.step = "name";
            orderSessions.set(senderId, session);

            await sendMessage(senderId, "Inona ny anaranao?");
            return;
          }

          // STEP 2: CUSTOMER NAME
          if (session && session.step === "name") {
            if (message.length < 2) {
              await sendMessage(senderId, "Ampidiro ny anaranao azafady.");
              return;
            }

            session.customer_name = message;
            session.step = "phone";
            orderSessions.set(senderId, session);

            await sendMessage(senderId, "Inona ny numéro téléphone anao?");
            return;
          }

          // STEP 3: PHONE AND SAVE ORDER
          if (session && session.step === "phone") {
            const phone = message.replace(/[\s-]/g, "");

            if (!/^\+?\d{8,15}$/.test(phone)) {
              await sendMessage(
                senderId,
                "Numéro téléphone tsy mety. Avereno azafady."
              );
              return;
            }

            const product = session.product;
            const total = Number(product.price) * session.quantity;

            const result = await pool.query(
              `INSERT INTO orders
              (sender_id, product_id, product_name, unit_price,
               quantity, customer_name, phone, total_price)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
              RETURNING *`,
              [
                senderId,
                product.id,
                product.name,
                Number(product.price),
                session.quantity,
                session.customer_name,
                phone,
                total
              ]
            );

            orderSessions.delete(senderId);

            await sendMessage(
              senderId,
              `✅ COMMANDE VOARAY!\n\nProduit: ${product.name}\nQuantité: ${session.quantity}\nPrix total: ${total} Ar\nAnarana: ${session.customer_name}\nTéléphone: ${phone}\n\nMisaotra anao niantsena teto amin'ny ONE STORE 😊`
            );
            console.log("New order saved:", result.rows[0].id);
            return;
          }

          // SHOW PRODUCTS
          const productKeywords = [
            "produit", "produits", "entana",
            "misy", "vidiny", "ohatrinona",
            "combien", "prix", "disponible",
            "catalogue", "article", "articles"
          ];

          const wantsProducts = productKeywords.some(word =>
            lowerMessage.includes(word)
          );

          if (wantsProducts) {
            const products = await getProducts();
            await sendMessage(
              senderId,
              buildProductsReply(products, language)
            );
            return;
          }

          // SELECT PRODUCT BY ID
          if (/^\d+$/.test(message)) {
            const productId = Number(message);

            const result = await pool.query(
              "SELECT id, name, price, stock FROM products WHERE id = $1",
              [productId]
            );

            if (result.rows.length === 0) {
              await sendMessage(senderId, "Tsy hita io numéro produit io.");
              return;
            }

            const product = result.rows[0];

            if (product.stock <= 0) {
              await sendMessage(senderId, "Lany stock io produit io.");
              return;
            }

            orderSessions.set(senderId, {
              step: "quantity",
              product: product
            });

            await sendMessage(
              senderId,
              `Produit: ${product.name}\nPrix: ${product.price} Ar\nStock: ${product.stock}\n\nFiry ny quantité tianao?`
            );
            return;
          }

          // DEFAULT GREETING
          const reply = language === "fr"
            ? "Bonjour 😊 Bienvenue chez ONE STORE ! Envoyez « produits » pour voir notre catalogue."
            : "Salama 😊 Tongasoa eto amin'ny ONE STORE ! Alefaso ny teny hoe produits raha hijery ny entana misy.";

          await sendMessage(senderId, reply);

        } catch (error) {
          console.error("Messenger automatic order error:", error);
          await sendMessage(
            senderId,
            "Nisy olana kely. Avereno azafady afaka kelikely."
          );
        }
      })();
    }
  }
});

// START SERVER
const PORT = process.env.PORT || 3000;

// CLOUDINARY IMAGE UPLOAD
app.post("/api/upload", express.raw({ type: "*/*", limit: "5mb" }), (req, res) => {
  if (!req.body || !req.body.length) {
    return res.status(400).json({ success: false, message: "Aucune image reçue." });
  }

  const stream = cloudinary.uploader.upload_stream(
    { folder: "one-store-ai" },
    (error, result) => {
      if (error) {
        console.error("Cloudinary upload error:", error);
        return res.status(500).json({ success: false, message: "Upload failed." });
      }
      res.json({ success: true, image_url: result.secure_url });
    }
  );
  stream.end(req.body);
});

// FACEBOOK LOGIN
app.get("/auth/facebook", (req, res) => {
  if (!APP_ID || !REDIRECT_URI || !FB_CONFIG_ID) {
    return res.status(500).send("Facebook configuration missing.");
  }

  const state = crypto.randomBytes(16).toString("hex");
  loginStates.set(state, Date.now());

  const loginUrl = new URL(`https://www.facebook.com/${API_VERSION}/dialog/oauth`);
  loginUrl.searchParams.set("client_id", APP_ID);
  loginUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  loginUrl.searchParams.set("config_id", FB_CONFIG_ID);
  loginUrl.searchParams.set("response_type", "code");
  loginUrl.searchParams.set("state", state);
  res.redirect(loginUrl.toString());
});

app.get("/auth/facebook/callback", async (req, res) => {
  try {
    const { code, state, error } = req.query;
    if (error) return res.status(400).send("Facebook login cancelled or denied.");

    const stateTime = loginStates.get(state);
    if (!code || !stateTime || Date.now() - stateTime > 600000) {
      return res.status(400).send("Invalid or expired login request.");
    }
    loginStates.delete(state);

    const tokenUrl = new URL(`https://graph.facebook.com/${API_VERSION}/oauth/access_token`);
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

    const pagesUrl = new URL(`https://graph.facebook.com/${API_VERSION}/me/accounts`);
    pagesUrl.searchParams.set("fields", "id,name,access_token");
    pagesUrl.searchParams.set("access_token", tokenData.access_token);

    const pagesResponse = await fetch(pagesUrl);
    const pagesData = await pagesResponse.json();
    if (!pagesResponse.ok || !pagesData.data || !pagesData.data.length) {
      console.error("Pages error:", pagesData);
      return res.status(400).send("No Facebook Page found or permission denied.");
    }

    const page = pagesData.data[0];
    await saveFacebookPage(page);
    console.log("Facebook Page saved:", page.name, page.id);

    res.send(`
      <h2>ONE STORE AI</h2>
      <p>Connexion Facebook réussie !</p>
      <p>Page connectée : ${String(page.name).replace(/[&<>"']/g, "")}</p>
      <p>Page Access Token enregistré dans la base de données.</p>
      <p>Vous pouvez retourner dans votre application.</p>
    `);
  } catch (error) {
    console.error("Facebook login error:", error);
    res.status(500).send("Facebook connection error.");
  }
});

// MESSENGER WEBHOOK VERIFICATION
app.get("/webhook", (req, res) => {
  if (
    req.query["hub.mode"] === "subscribe" &&
    req.query["hub.verify_token"] === VERIFY_TOKEN
  ) {
    return res.send(req.query["hub.challenge"]);
  }
  res.sendStatus(403);
});

// MESSENGER WEBHOOK: CONVERSATION + ORDER FLOW
app.post("/webhook", (req, res) => {
  res.sendStatus(200);
  if (!req.body || req.body.object !== "page") return;

  for (const entry of req.body.entry || []) {
    for (const event of entry.messaging || []) {
      if (!event.message || event.message.is_echo) continue;

      const senderId = event.sender && event.sender.id;
      const receivedText = event.message.text;
      if (!senderId || !receivedText) continue;

      (async () => {
        try {
          const text = String(receivedText).trim();
          const message = cleanText(text);
          const conversation = await getConversation(senderId);
          const language = detectLanguage(text);
          const lang = language || conversation.language || "mg";

          // Human takeover: the bot stays silent until admin resumes it.
          if (conversation.human_mode) {
            console.log("Human mode active for:", senderId);
            return;
          }

          // Explicit request for a human operator.
          if (isHumanRequest(message)) {
            await saveConversation(senderId, {
              language: lang,
              human_mode: true,
              last_message: text
            });
            await sendMessage(
              senderId,
              lang === "fr"
                ? "Bien sûr 😊 Je transmets votre demande à notre équipe. Un conseiller prendra la conversation en charge."
                : "Eny ary 😊 Ampitako amin'ny mpikambana ao amin'ny ONE STORE ny fangatahanao. Handray an-tanana ny resaka izy."
            );
            return;
          }

          // Cancel current order.
          if (["cancel", "annuler", "foana", "ajanony"].includes(message)) {
            orderSessions.delete(senderId);
            await saveConversation(senderId, {
              language: lang,
              context: {},
              last_message: text
            });
            await sendMessage(
              senderId,
              lang === "fr" ? "Votre commande est annulée. Vous pouvez recommencer quand vous voulez." : "Nofoanana ny commande. Afaka manomboka indray ianao rehefa vonona."
            );
            return;
          }

          // Continue an order already in progress.
          const session = orderSessions.get(senderId);

          if (session && session.step === "quantity") {
            const quantity = Number(text);
            if (!Number.isInteger(quantity) || quantity <= 0) {
              await sendMessage(senderId, lang === "fr" ? "Indiquez une quantité entière valide, s'il vous plaît." : "Ampidiro ny quantité isa feno azafady.");
              return;
            }
            if (quantity > Number(session.product.stock)) {
              await sendMessage(
                senderId,
                lang === "fr"
                  ? `Stock disponible : ${session.product.stock}. Choisissez une quantité inférieure ou égale.`
                  : `Stock misy: ${session.product.stock}. Misafidiana quantité tsy mihoatra an'io.`
              );
              return;
            }
            session.quantity = quantity;
            session.step = "name";
            orderSessions.set(senderId, session);
            await sendMessage(senderId, lang === "fr" ? "À quel nom dois-je enregistrer la commande ?" : "Amin'ny anarana iza no hanoratana ny commande?");
            return;
          }

          if (session && session.step === "name") {
                        if (text.length < 2 || /^\d+$/.test(text)) {
              await sendMessage(senderId, lang === "fr" ? "Veuillez saisir votre nom, s'il vous plaît." : "Ampidiro ny anaranao azafady.");
              return;
            }
            session.customer_name = text;
            session.step = "phone";
            orderSessions.set(senderId, session);
            await sendMessage(senderId, lang === "fr" ? "Quel est votre numéro de téléphone ?" : "Inona ny numéro téléphone anao?");
            return;
          }

          if (session && session.step === "phone") {
            const phone = text.replace(/[\s-]/g, "");
            if (!/^\+?\d{8,15}$/.test(phone)) {
              await sendMessage(senderId, lang === "fr" ? "Ce numéro semble invalide. Envoyez 8 à 15 chiffres, s'il vous plaît." : "Toa tsy mety ilay numéro. Avereno amin'ny isa 8 hatramin'ny 15 azafady.");
              return;
            }

            const product = session.product;
            const total = Number(product.price) * session.quantity;
            const result = await pool.query(
              `INSERT INTO orders
               (sender_id, product_id, product_name, unit_price, quantity,
                customer_name, phone, total_price)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
              [senderId, product.id, product.name, Number(product.price),
                session.quantity, session.customer_name, phone, total]
            );

            orderSessions.delete(senderId);
            await saveConversation(senderId, {
              language: lang,
              context: { last_order_id: result.rows[0].id },
              last_message: text
            });

            await sendMessage(
              senderId,
              lang === "fr"
                ? `✅ Votre commande est bien enregistrée !\n\nProduit : ${product.name}\nQuantité : ${session.quantity}\nTotal : ${total.toLocaleString("fr-FR")} Ar\nNom : ${session.customer_name}\nTéléphone : ${phone}\n\nNotre équipe vous contactera pour confirmer les détails. Merci pour votre confiance 😊`
                : `✅ Voaray tsara ny commande-nao!\n\nProduit: ${product.name}\nQuantité: ${session.quantity}\nTotal: ${total.toLocaleString("fr-FR")} Ar\nAnarana: ${session.customer_name}\nTéléphone: ${phone}\n\nHifandray aminao ny ekipanay hanamarina ny antsipiriany. Misaotra anao nisafidy ONE STORE 😊`
            );
            console.log("New order saved:", result.rows[0].id);
            return;
          }

          // Product selection by ID.
          if (/^\d+$/.test(text)) {
            const productResult = await pool.query(
              "SELECT id, name, price, stock, description FROM products WHERE id = $1",
              [Number(text)]
            );
            if (!productResult.rows.length) {
              await sendMessage(senderId, lang === "fr" ? "Je ne trouve pas ce numéro de produit. Envoyez « produits » pour voir le catalogue." : "Tsy hitako io numéro produit io. Alefaso ny hoe produits hijerena ny catalogue.");
              return;
            }

            const product = productResult.rows[0];
            if (Number(product.stock) <= 0) {
              await sendMessage(senderId, lang === "fr" ? "Ce produit est actuellement en rupture de stock." : "Lany stock amin'izao fotoana izao io produit io.");
              return;
            }

            orderSessions.set(senderId, { step: "quantity", product });
            const details = product.description ? `\n${product.description}` : "";
            await sendMessage(
              senderId,
              lang === "fr"
                ? `${product.name}\nPrix : ${Number(product.price).toLocaleString("fr-FR")} Ar\nStock : ${product.stock}${details}\n\nQuelle quantité souhaitez-vous ?`
                : `${product.name}\nVidiny: ${Number(product.price).toLocaleString("fr-FR")} Ar\nStock: ${product.stock}${details}\n\nFiry ny quantité ilainao?`
            );
            return;
          }

          // Product catalogue and availability questions.
          if (isProductQuestion(message)) {
            const products = await getProducts();
            await saveConversation(senderId, {
              language: lang,
              last_message: text
            });
            await sendMessage(senderId, productsReply(products, lang));
            return;
          }

          // Greetings: greet once naturally; no generic reply to every message.
          if (isGreeting(message)) {
            await saveConversation(senderId, {
              language: lang,
              last_message: text
            });
            await sendMessage(
              senderId,
              lang === "fr"
                ? "Bonjour et bienvenue chez ONE STORE 😊 Que recherchez-vous aujourd'hui ? Je peux vous présenter nos produits ou vous aider à commander."
                : "Salama 😊 Tongasoa eto amin'ny ONE STORE! Inona no tadiavinao androany? Afaka asehoko anao ny produits na afaka manampy anao hanao commande aho."
            );
            return;
          }

          if (isThanks(message)) {
            await saveConversation(senderId, {
              language: lang,
              last_message: text
            });
            await sendMessage(
              senderId,
              lang === "fr"
                ? "Avec plaisir 😊 Je reste disponible si vous avez une question sur un produit ou une commande."
                : "Tsy misy fisaorana 😊 Eto foana izahay raha misy fanontaniana momba ny produit na commande."
            );
            return;
          }

          // Safe fallback: ask for clarification instead of inventing an answer.
          await saveConversation(senderId, {
            language: lang,
            last_message: text
          });
          await sendMessage(
            senderId,
            lang === "fr"
              ? "Merci pour votre message 😊 Pour mieux vous aider, souhaitez-vous connaître nos produits, leurs prix, le stock ou passer une commande ? Vous pouvez aussi demander à parler à un conseiller."
              : "Misaotra amin'ny hafatrao 😊 Mba hanampiana anao tsara, inona no tianao ho fantatra: produits, vidiny, stock sa hanao commande? Afaka mangataka hiresaka amin'ny mpivarotra ihany koa ianao."
          );
        } catch (error) {
          console.error("Messenger assistant error:", error);
          try {
            await sendMessage(
              senderId,
              "Miala tsiny fa nisy olana ara-teknika. Afaka averinao kely ve ny hafatrao?"
            );
          } catch (sendError) {
            console.error("Fallback message error:", sendError);
          }
        }
      })();
    }
  }
});

// SERVER START

initDatabase()
  .then(() => {
    app.listen(PORT, () => {
      console.log("ONE STORE AI running on port " + PORT);
    });
  })
  .catch(error => {
    console.error("Database initialization failed:", error);
    process.exit(1);
  });
