const http = require("http");
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "inventory.json");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const PUBLIC_DIR = path.join(__dirname, "public");
const SESSION_SECRET = process.env.SESSION_SECRET || "change-this-secret-before-production";

const rolePermissions = {
  admin: ["read", "create", "update", "delete"],
  operator: ["read", "create", "update"],
  viewer: ["read"]
};

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

  try {
    await fs.access(USERS_FILE);
  } catch {
    const users = [
      createUser("admin", "Admin", "admin", "admin123"),
      createUser("operator", "Operator", "operator", "operator123"),
      createUser("viewer", "Viewer", "viewer", "viewer123")
    ];
    await fs.writeFile(USERS_FILE, JSON.stringify({ users }, null, 2));
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

async function readUsers() {
  await ensureDatabase();
  const raw = await fs.readFile(USERS_FILE, "utf8");
  return JSON.parse(raw);
}

async function writeUsers(data) {
  await fs.writeFile(USERS_FILE, JSON.stringify(data, null, 2));
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

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, "sha512").toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, storedHash) {
  const [salt, originalHash] = storedHash.split(":");
  const hash = hashPassword(password, salt).split(":")[1];
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(originalHash, "hex"));
}

function createUser(username, displayName, role, password) {
  return {
    id: crypto.randomUUID(),
    username,
    displayName,
    role,
    passwordHash: hashPassword(password),
    createdAt: new Date().toISOString()
  };
}

function parseCookies(req) {
  return Object.fromEntries(
    String(req.headers.cookie || "")
      .split(";")
      .filter(Boolean)
      .map(cookie => {
        const [name, ...rest] = cookie.trim().split("=");
        return [name, decodeURIComponent(rest.join("="))];
      })
  );
}

function signSession(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto.createHmac("sha256", SESSION_SECRET).update(body).digest("base64url");
  return `${body}.${signature}`;
}

function verifySession(token) {
  if (!token || !token.includes(".")) return null;
  const [body, signature] = token.split(".");
  const expectedSignature = crypto.createHmac("sha256", SESSION_SECRET).update(body).digest("base64url");

  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) {
    return null;
  }

  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  if (payload.expiresAt < Date.now()) return null;
  return payload;
}

async function getCurrentUser(req) {
  const cookies = parseCookies(req);
  const session = verifySession(cookies.session);
  if (!session) return null;

  const userDb = await readUsers();
  const user = userDb.users.find(entry => entry.id === session.userId);
  if (!user) return null;

  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    permissions: rolePermissions[user.role] || []
  };
}

function requirePermission(user, permission) {
  if (!user) {
    const error = new Error("Please log in to continue.");
    error.statusCode = 401;
    throw error;
  }

  if (!user.permissions.includes(permission)) {
    const error = new Error("You do not have permission for this action.");
    error.statusCode = 403;
    throw error;
  }
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
  const currentUser = await getCurrentUser(req);

  if (req.method === "GET" && url.pathname === "/api/me") {
    sendJson(res, 200, currentUser);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/login") {
    const body = await parseBody(req);
    const username = cleanText(body.username).toLowerCase();
    const password = String(body.password || "");
    const userDb = await readUsers();
    const user = userDb.users.find(entry => entry.username.toLowerCase() === username);

    if (!user || !verifyPassword(password, user.passwordHash)) {
      sendJson(res, 401, { error: "Invalid username or password." });
      return;
    }

    const safeUser = {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      role: user.role,
      permissions: rolePermissions[user.role] || []
    };
    const token = signSession({
      userId: user.id,
      expiresAt: Date.now() + 1000 * 60 * 60 * 8
    });

    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Set-Cookie": `session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800`
    });
    res.end(JSON.stringify(safeUser));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/signup") {
    const body = await parseBody(req);
    const username = cleanText(body.username).toLowerCase();
    const displayName = cleanText(body.displayName);
    const password = String(body.password || "");

    if (!/^[a-z0-9_]{3,24}$/.test(username)) {
      throw new Error("Username must be 3-24 characters and use only letters, numbers, or underscore.");
    }

    if (!displayName) {
      throw new Error("Display name is required.");
    }

    if (password.length < 6) {
      throw new Error("Password must be at least 6 characters.");
    }

    const userDb = await readUsers();
    const usernameExists = userDb.users.some(entry => entry.username.toLowerCase() === username);

    if (usernameExists) {
      sendJson(res, 409, { error: "That username is already taken." });
      return;
    }

    const user = createUser(username, displayName, "viewer", password);
    userDb.users.push(user);
    await writeUsers(userDb);

    const safeUser = {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      role: user.role,
      permissions: rolePermissions[user.role] || []
    };
    const token = signSession({
      userId: user.id,
      expiresAt: Date.now() + 1000 * 60 * 60 * 8
    });

    res.writeHead(201, {
      "Content-Type": "application/json; charset=utf-8",
      "Set-Cookie": `session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800`
    });
    res.end(JSON.stringify(safeUser));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/logout") {
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Set-Cookie": "session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0"
    });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/items") {
    requirePermission(currentUser, "read");
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
    requirePermission(currentUser, "create");
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
      requirePermission(currentUser, "read");
      sendJson(res, 200, item);
      return;
    }

    if (req.method === "PATCH" && parts[3] === "quantity") {
      requirePermission(currentUser, "update");
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
      requirePermission(currentUser, "delete");
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
    sendJson(res, error.statusCode || 400, { error: error.message || "Something went wrong." });
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
