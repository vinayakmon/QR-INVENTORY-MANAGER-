const http = require("http");
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "inventory.json");
const PUBLIC_DIR = path.join(__dirname, "public");

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml"
};

async function ensureDatabase() {
  await fs.mkdir(DATA_DIR, { recursive: true });

  try {
    await fs.access(DB_FILE);
  } catch {
    await fs.writeFile(DB_FILE, JSON.stringify({ items: [] }, null, 2));
  }
}

async function readDatabase() {
  await ensureDatabase();
  const raw = await fs.readFile(DB_FILE, "utf8");
  return JSON.parse(raw);
}

async function writeDatabase(data) {
  await fs.writeFile(DB_FILE, JSON.stringify(data, null, 2));
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", chunk => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error("Request body is too large."));
        req.destroy();
      }
    });

    req.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("Invalid JSON body."));
      }
    });
  });
}

function cleanText(value) {
  return String(value || "").trim();
}

function makeItemCode() {
  const date = new Date();
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const random = crypto.randomBytes(3).toString("hex").toUpperCase();
  return `QRINV-${yyyy}${mm}${dd}-${random}`;
}

function validateQuantity(value, fieldName) {
  const number = Number(value);

  if (!Number.isInteger(number) || number < 0) {
    throw new Error(`${fieldName} must be a whole number greater than or equal to 0.`);
  }

  return number;
}

async function handleApi(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const parts = url.pathname.split("/").filter(Boolean);

  if (req.method === "GET" && url.pathname === "/api/items") {
    const db = await readDatabase();
    const search = cleanText(url.searchParams.get("search")).toLowerCase();
    const items = search
      ? db.items.filter(item =>
          [item.code, item.productName, item.location, item.unit]
            .join(" ")
            .toLowerCase()
            .includes(search)
        )
      : db.items;

    sendJson(res, 200, items);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/items") {
    const body = await parseBody(req);
    const productName = cleanText(body.productName);
    const unit = cleanText(body.unit);
    const location = cleanText(body.location);
    const notes = cleanText(body.notes);
    const initialQuantity = validateQuantity(body.initialQuantity, "Initial quantity");

    if (!productName) throw new Error("Product name is required.");
    if (!unit) throw new Error("Unit is required.");

    const now = new Date().toISOString();
    const item = {
      id: crypto.randomUUID(),
      code: makeItemCode(),
      productName,
      unit,
      initialQuantity,
      currentQuantity: initialQuantity,
      location,
      notes,
      createdAt: now,
      updatedAt: now,
      history: [
        {
          action: "created",
          quantity: initialQuantity,
          note: "Batch created",
          at: now
        }
      ]
    };

    const db = await readDatabase();
    db.items.unshift(item);
    await writeDatabase(db);
    sendJson(res, 201, item);
    return;
  }

  if (parts[0] === "api" && parts[1] === "items" && parts[2]) {
    const db = await readDatabase();
    const itemIndex = db.items.findIndex(entry => entry.id === parts[2] || entry.code === parts[2]);
    const item = db.items[itemIndex];

    if (!item) {
      sendJson(res, 404, { error: "Item not found." });
      return;
    }

    if (req.method === "GET") {
      sendJson(res, 200, item);
      return;
    }

    if (req.method === "PATCH" && parts[3] === "quantity") {
      const body = await parseBody(req);
      const mode = cleanText(body.mode);
      const amount = validateQuantity(body.amount, "Quantity");
      const note = cleanText(body.note);
      let nextQuantity = item.currentQuantity;

      if (mode === "add") nextQuantity += amount;
      if (mode === "remove") nextQuantity -= amount;
      if (mode === "set") nextQuantity = amount;

      if (!["add", "remove", "set"].includes(mode)) {
        throw new Error("Quantity mode must be add, remove, or set.");
      }

      if (nextQuantity < 0) {
        throw new Error("Current quantity cannot go below 0.");
      }

      const now = new Date().toISOString();
      item.currentQuantity = nextQuantity;
      item.updatedAt = now;
      item.history.unshift({
        action: mode,
        quantity: amount,
        note,
        at: now
      });

      await writeDatabase(db);
      sendJson(res, 200, item);
      return;
    }

    if (req.method === "DELETE") {
      db.items.splice(itemIndex, 1);
      await writeDatabase(db);
      sendJson(res, 200, { ok: true });
      return;
    }
  }

  sendJson(res, 404, { error: "API route not found." });
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const requestedPath = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname);
  const safePath = path
    .normalize(requestedPath)
    .replace(/^(\.\.[/\\])+/, "")
    .replace(/^[/\\]+/, "");
  const filePath = path.join(PUBLIC_DIR, safePath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const file = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "Content-Type": mimeTypes[ext] || "application/octet-stream" });
    res.end(file);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.url.startsWith("/api/")) {
      await handleApi(req, res);
    } else {
      await serveStatic(req, res);
    }
  } catch (error) {
    sendJson(res, 400, { error: error.message || "Something went wrong." });
  }
});

ensureDatabase()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`QR Inventory Management is running at http://localhost:${PORT}`);
    });
  })
  .catch(error => {
    console.error("Could not start server:", error);
    process.exit(1);
  });
