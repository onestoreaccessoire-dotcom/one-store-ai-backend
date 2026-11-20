const express = require("express");
const app = express();

app.use(express.json());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;

app.get("/", (req, res) => {
  res.send("ONE STORE AI Backend is running!");
});

app.get("/webhook", (req, res) => {
  if (
    req.query["hub.mode"] === "subscribe" &&
    req.query["hub.verify_token"] === VERIFY_TOKEN
  ) {
    return res.send(req.query["hub.challenge"]);
  }

  res.sendStatus(403);
});

async function sendMessage(senderId, message) {
  const url =
    "https://graph.facebook.com/v27.0/me/messages?access_token=" +
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
});const express = require("express");
const app = express();

app.use(express.json());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;

app.get("/", (req, res) => {
  res.send("ONE STORE AI Backend is running!");
});

app.get("/webhook", (req, res) => {
  if (
    req.query["hub.mode"] === "subscribe" &&
    req.query["hub.verify_token"] === VERIFY_TOKEN
  ) {
    return res.send(req.query["hub.challenge"]);
  }

  res.sendStatus(403);
});

async function sendMessage(senderId, message) {
  const url =
    "https://graph.facebook.com/v27.0/me/messages?access_token=" +
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
