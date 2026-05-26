const itemForm = document.querySelector("#itemForm");
const inventoryList = document.querySelector("#inventoryList");
const searchInput = document.querySelector("#searchInput");
const message = document.querySelector("#message");
const itemCount = document.querySelector("#itemCount");
const qrDialog = document.querySelector("#qrDialog");
const closeDialog = document.querySelector("#closeDialog");
const printQr = document.querySelector("#printQr");

let inventory = [];

function showMessage(text, isError = false) {
  message.textContent = text;
  message.classList.toggle("error", isError);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options
  });
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || "Request failed.");
  }

  return data;
}

function qrPayload(item) {
  return JSON.stringify({
    code: item.code,
    id: item.id,
    productName: item.productName
  });
}

function formatDate(value) {
  return new Date(value).toLocaleString();
}

function quantityClass(item) {
  if (item.currentQuantity === 0) return "warn";
  return "good";
}

function renderInventory() {
  itemCount.textContent = inventory.length;

  if (!inventory.length) {
    inventoryList.innerHTML = `<p class="item-notes">No batches found. Create your first QR batch from the form.</p>`;
    return;
  }

  inventoryList.innerHTML = inventory
    .map(item => {
      const latest = item.history[0];
      return `
        <article class="item-card">
          <div>
            <div class="item-title">
              <h3>${escapeHtml(item.productName)}</h3>
              <span class="code">${escapeHtml(item.code)}</span>
            </div>
            <div class="meta">
              <span class="tag ${quantityClass(item)}">${item.currentQuantity} ${escapeHtml(item.unit)} available</span>
              <span class="tag">Started with ${item.initialQuantity} ${escapeHtml(item.unit)}</span>
              <span class="tag">${escapeHtml(item.location || "No location")}</span>
            </div>
            <p class="item-notes">${escapeHtml(item.notes || "No notes added.")}</p>
            <div class="history">
              Last update: ${latest ? `${escapeHtml(latest.action)} ${latest.quantity} on ${formatDate(latest.at)}` : "No updates yet"}
            </div>
          </div>

          <form class="actions" data-id="${item.id}">
            <select name="mode" aria-label="Quantity update type">
              <option value="remove">Remove used quantity</option>
              <option value="add">Add received quantity</option>
              <option value="set">Set exact quantity</option>
            </select>
            <input name="amount" type="number" min="0" step="1" placeholder="Qty" required />
            <input class="wide" name="note" placeholder="Reason: issued to job, stock correction..." />
            <button type="submit">Update</button>
            <button type="button" data-qr="${item.id}">Show QR</button>
            <button class="wide delete-button" type="button" data-delete="${item.id}">Delete Batch</button>
          </form>
        </article>
      `;
    })
    .join("");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function loadInventory() {
  const search = encodeURIComponent(searchInput.value.trim());
  inventory = await api(`/api/items${search ? `?search=${search}` : ""}`);
  renderInventory();
}

function openQr(item) {
  document.querySelector("#qrTitle").textContent = "QR Label";
  document.querySelector("#qrProduct").textContent = item.productName;
  document.querySelector("#qrCodeText").textContent = item.code;
  document.querySelector("#qrQuantity").textContent = `${item.currentQuantity} ${item.unit} available`;
  document.querySelector("#qrLocation").textContent = item.location || "No location";

  const qrCode = document.querySelector("#qrCode");
  qrCode.innerHTML = "";

  if (window.QRCode) {
    new QRCode(qrCode, {
      text: qrPayload(item),
      width: 190,
      height: 190,
      correctLevel: QRCode.CorrectLevel.M
    });
  } else {
    qrCode.textContent = "QR library could not load. Check your internet connection.";
  }

  qrDialog.showModal();
}

itemForm.addEventListener("submit", async event => {
  event.preventDefault();
  const formData = new FormData(itemForm);

  try {
    const item = await api("/api/items", {
      method: "POST",
      body: JSON.stringify(Object.fromEntries(formData))
    });
    itemForm.reset();
    showMessage(`Saved ${item.productName} and generated ${item.code}.`);
    await loadInventory();
    openQr(item);
  } catch (error) {
    showMessage(error.message, true);
  }
});

inventoryList.addEventListener("submit", async event => {
  event.preventDefault();
  const form = event.target;
  const id = form.dataset.id;
  const formData = new FormData(form);

  try {
    await api(`/api/items/${id}/quantity`, {
      method: "PATCH",
      body: JSON.stringify(Object.fromEntries(formData))
    });
    form.reset();
    showMessage("Quantity updated.");
    await loadInventory();
  } catch (error) {
    showMessage(error.message, true);
  }
});

inventoryList.addEventListener("click", event => {
  const button = event.target.closest("[data-qr]");
  if (!button) return;

  const item = inventory.find(entry => entry.id === button.dataset.qr);
  if (item) openQr(item);
});

inventoryList.addEventListener("click", async event => {
  const button = event.target.closest("[data-delete]");
  if (!button) return;

  const item = inventory.find(entry => entry.id === button.dataset.delete);
  if (!item) return;

  const confirmed = window.confirm(`Delete ${item.productName} (${item.code})?`);
  if (!confirmed) return;

  try {
    await api(`/api/items/${item.id}`, { method: "DELETE" });
    showMessage("Batch deleted.");
    await loadInventory();
  } catch (error) {
    showMessage(error.message, true);
  }
});

searchInput.addEventListener("input", () => {
  window.clearTimeout(searchInput.searchTimer);
  searchInput.searchTimer = window.setTimeout(loadInventory, 200);
});

closeDialog.addEventListener("click", () => qrDialog.close());
printQr.addEventListener("click", () => window.print());

loadInventory().catch(error => showMessage(error.message, true));
