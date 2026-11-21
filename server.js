const express = require("express");
const app = express();

app.use(express.json());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
let PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;

const APP_ID = process.env.APP_ID;
const APP_SECRET = process.env.APP_SECRET;
const REDIRECT_URI = process.env.OAUTH_REDIRECT_URI;
const FB_CONFIG_ID = process.env.FB_CONFIG_ID;

const API_VERSION = "v27.0";
const loginStates = new Set();

app.get("/", (req, res) => {
  res.send("ONE STORE AI Backend is running!");
});

// FACEBOOK LOGIN
app.get("/auth/facebook", (req, res) => {
  if (!APP_ID || !REDIRECT_URI || !FB_CONFIG_ID) {
    return res.status(500).send("Facebook Login configuration missing.");
  }

  const state = require("crypto").randomBytes(16).toString("hex");
  loginStates.add(state);

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
      return res.status(400).send("Facebook login was cancelled or denied.");
    }

    if (!code || !state || !loginStates.has(state)) {
      return res.status(400).send("Invalid Facebook login request.");
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
      return res.status(400).send(
        "No Facebook Page found or permission not granted."
      );
    }

    const page = pagesData.data[0];

    PAGE_ACCESS_TOKEN = page.access_token;

    console.log("Facebook Page connected:", page.name, page.id);

    res.send(`
      <h2>ONE STORE AI</h2>
      <p>Connexion Facebook réussie !</p>
      <p>Page connectée : ${page.name}</p>
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

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("ONE STORE AI running on port " + PORT);
});
