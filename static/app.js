const state = {
  mode: "provider",
  providerTab: "deliveries",
  customerTab: "home",
  activeQueue: "lunch",
  routeFilter: "ALL",
  customerSearch: "",
  loggedInCustomerId: null,
  actionCustomerId: null,
  dashboard: null, // provider data (needs provider login)
  summary: null, // signed-in customer's own data
  providerToken: null,
  customerAuth: null, // { token, id }
  demo: { enabled: false },
  lastBroadcastSeen: "",
  popupMealType: "lunch",
  scannerMealType: "lunch",
  videoStream: null,
  scanTimer: null,
};

const PLAN_LABELS = {
  lunch_only: "Lunch Only",
  dinner_only: "Dinner Only",
  both: "Lunch + Dinner",
};

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Safe value for a JS argument inside an inline on* attribute: a JSON string literal, then HTML-escaped.
function jsArg(value) {
  return esc(JSON.stringify(String(value ?? "")));
}

const AUTH_KEYS = { provider: "dabba.providerToken", customer: "dabba.customerAuth" };

function storeGet(key) {
  try {
    return localStorage.getItem(key);
  } catch (_) {
    return null;
  }
}

function storeSet(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch (_) {
    // Private mode etc.: stay signed in for this tab only.
  }
}

function setProviderToken(token) {
  state.providerToken = token;
  storeSet(AUTH_KEYS.provider, token);
  if (!token) state.dashboard = null;
}

function setCustomerAuth(auth) {
  state.customerAuth = auth;
  storeSet(AUTH_KEYS.customer, auth ? JSON.stringify(auth) : null);
}

// Token for customer-portal calls: the customer's own, or the provider's when previewing a customer.
function customerToken() {
  if (state.customerAuth && state.customerAuth.id === state.loggedInCustomerId) return state.customerAuth.token;
  return state.providerToken;
}

function formatDate(isoDate) {
  if (!isoDate) return "-";
  const dt = new Date(`${isoDate}T00:00:00`);
  if (Number.isNaN(dt.getTime())) return isoDate;
  return dt.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

function formatDateTime(isoTs) {
  if (!isoTs) return "";
  const dt = new Date(isoTs);
  if (Number.isNaN(dt.getTime())) return isoTs;
  return dt.toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

function showToast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => el.classList.add("hidden"), 3400);
}

function handleUnauthorized(token) {
  if (!token) return;
  if (token === state.providerToken) {
    setProviderToken(null);
    if (!state.customerAuth || state.customerAuth.id !== state.loggedInCustomerId) {
      state.loggedInCustomerId = null;
      state.summary = null;
    }
  } else if (state.customerAuth && token === state.customerAuth.token) {
    setCustomerAuth(null);
    state.loggedInCustomerId = null;
    state.summary = null;
  }
  render();
}

// options.token: bearer token to send (provider or customer).
async function api(url, options = {}) {
  const { token, ...init } = options;
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url, { ...init, headers });
  let data = {};
  try {
    data = await res.json();
  } catch (_) {
    data = {};
  }
  if (!res.ok) {
    if (res.status === 401) handleUnauthorized(token);
    throw new Error(data.error || `Request failed (HTTP ${res.status})`);
  }
  return data;
}

const providerApi = (url, options = {}) => api(url, { ...options, token: state.providerToken });
const customerApi = (url, options = {}) => api(url, { ...options, token: customerToken() });

async function loadProvider() {
  if (!state.providerToken) {
    state.dashboard = null;
    return;
  }
  try {
    state.dashboard = await providerApi("/api/dashboard");
    await loadProviderQr();
  } catch (err) {
    showToast(err.message);
  }
}

async function loadProviderQr() {
  const img = document.getElementById("providerQrImg");
  try {
    const res = await fetch("/api/qr.svg", { headers: { Authorization: `Bearer ${state.providerToken}` } });
    if (!res.ok) return;
    const url = URL.createObjectURL(await res.blob());
    if (img.dataset.objectUrl) URL.revokeObjectURL(img.dataset.objectUrl);
    img.dataset.objectUrl = url;
    img.src = url;
  } catch (_) {
    // Image is optional; the code text is still shown.
  }
}

async function loadCustomer() {
  if (!state.loggedInCustomerId || !customerToken()) {
    state.summary = null;
    return;
  }
  try {
    state.summary = await customerApi(`/api/customers/${state.loggedInCustomerId}/summary`);
  } catch (err) {
    state.summary = null;
    showToast(err.message);
  }
}

async function loadDemoInfo() {
  try {
    state.demo = await api("/api/demo");
  } catch (_) {
    state.demo = { enabled: false };
  }
}

// Reload whatever the signed-in roles can see, then redraw.
async function loadDashboard() {
  await Promise.all([loadProvider(), loadCustomer()]);
  render();
  checkForPopupTrigger();
}

function setMode(mode) {
  state.mode = mode;
  document.getElementById("modeProviderBtn").classList.toggle("active", mode === "provider");
  document.getElementById("modeCustomerBtn").classList.toggle("active", mode === "customer");
  document.getElementById("providerView").classList.toggle("hidden", mode !== "provider");
  document.getElementById("customerView").classList.toggle("hidden", mode !== "customer");
  renderBottomNavs();
  render();
  checkForPopupTrigger();
}

function setProviderTab(tab) {
  state.providerTab = tab;
  const pages = {
    deliveries: "providerPageDeliveries",
    customers: "providerPageCustomers",
    qrmenu: "providerPageQrMenu",
    more: "providerPageMore",
  };
  for (const [key, id] of Object.entries(pages)) {
    document.getElementById(id).classList.toggle("hidden", key !== tab);
  }
  document.querySelectorAll("[data-ptab]").forEach((b) => {
    b.classList.toggle("active", b.dataset.ptab === tab);
  });
  window.scrollTo({ top: 0, behavior: "instant" });
}

function setCustomerTab(tab) {
  state.customerTab = tab;
  const pages = {
    home: "customerPageHome",
    pause: "customerPagePause",
    history: "customerPageHistory",
  };
  for (const [key, id] of Object.entries(pages)) {
    document.getElementById(id).classList.toggle("hidden", key !== tab);
  }
  document.querySelectorAll("[data-ctab]").forEach((b) => {
    b.classList.toggle("active", b.dataset.ctab === tab);
  });
  window.scrollTo({ top: 0, behavior: "instant" });
}

function renderBottomNavs() {
  const showProviderNav = state.mode === "provider" && Boolean(state.dashboard);
  const showCustomerNav = state.mode === "customer" && Boolean(state.summary);
  document.getElementById("providerBottomNav").classList.toggle("hidden", !showProviderNav);
  document.getElementById("customerBottomNav").classList.toggle("hidden", !showCustomerNav);
}

function render() {
  const head = state.dashboard || state.summary;
  if (head) {
    document.getElementById("todayLabel").textContent = `${formatDate(head.today)} • ${head.current_time}`;
    document.getElementById("newCustomerStart").value ||= head.today;
    document.getElementById("holidayDateInput").value ||= head.today;
    document.getElementById("pauseStartDate").value ||= head.today;
    document.getElementById("pauseEndDate").value ||= head.today;
  } else {
    document.getElementById("todayLabel").textContent = "Please sign in";
  }

  renderBottomNavs();
  renderProviderView(state.dashboard);
  renderCustomerView(state.summary);
}

function renderQueueCard(item, mealType) {
  const canDeliver = item.status === "pending" || item.status === "confirmed";
  const tsText = item.delivered_at ? `Delivered ${formatDateTime(item.delivered_at)}` : "";

  return `
    <div class="item-card">
      <div class="row-between">
        <div>
          <div class="item-title">${esc(item.name)}</div>
          <div class="muted">${esc(item.address)}</div>
        </div>
        <span class="badge badge-${esc(item.status)}">${esc(item.status)}</span>
      </div>
      <div class="row-between">
        <div class="muted">
          <strong>${item.diets_remaining}</strong> diets left •
          <strong>${item.boxes_with_customer}</strong> box${item.boxes_with_customer === 1 ? "" : "es"} held
          ${tsText ? `<br>${esc(tsText)}` : ""}
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;">
          ${
            canDeliver
              ? `<button class="btn btn-sm btn-green" onclick="manualDeliver(${Number(item.customer_id)}, ${jsArg(mealType)}, true)">Delivered + Box Back</button>
                 <button class="btn btn-sm btn-soft" onclick="manualDeliver(${Number(item.customer_id)}, ${jsArg(mealType)}, false)">Delivered</button>`
              : item.boxes_with_customer > 0
              ? `<button class="btn btn-sm btn-soft" onclick="adjustBox(${Number(item.customer_id)}, -1)">Box Back (-1)</button>`
              : ""
          }
        </div>
      </div>
    </div>
  `;
}

function renderProviderView(d) {
  const signedIn = Boolean(d);
  document.getElementById("providerLoginCard").classList.toggle("hidden", signedIn);
  document.getElementById("providerPortal").classList.toggle("hidden", !signedIn);
  const demoHint = document.getElementById("providerDemoHint");
  const demoPin = state.demo && state.demo.enabled ? state.demo.provider_pin : null;
  demoHint.classList.toggle("hidden", !demoPin);
  demoHint.textContent = demoPin ? `Demo server: provider PIN is ${demoPin}.` : "";
  if (!signedIn) return;

  const queue = state.activeQueue === "lunch" ? d.lunch_queue : d.dinner_queue;

  document.getElementById("kpiMealLeft").textContent = queue.is_holiday ? "Off" : queue.counts.left_to_deliver;
  document.getElementById("kpiMealLeftLabel").textContent =
    state.activeQueue === "lunch" ? "Lunch Left" : "Dinner Left";
  document.getElementById("kpiMealDone").textContent = queue.counts.delivered;
  document.getElementById("kpiBoxesOut").textContent = d.total_boxes_out;

  const cutoffBadge = document.getElementById("queueCutoffBadge");
  cutoffBadge.textContent = queue.is_locked
    ? `Locked (${d.cutoffs[queue.meal_type]})`
    : `Open till ${d.cutoffs[queue.meal_type]}`;
  cutoffBadge.className = `badge ${queue.is_locked ? "badge-cancelled" : "badge-confirmed"}`;

  // Route filter chips
  const allRoutes = [...new Set(d.customers.map((c) => c.route_area || "General"))].sort();
  if (state.routeFilter !== "ALL" && !allRoutes.includes(state.routeFilter)) {
    state.routeFilter = "ALL";
  }
  const chipsEl = document.getElementById("routeChips");
  chipsEl.innerHTML =
    `<button class="pill-btn ${state.routeFilter === "ALL" ? "active" : ""}" onclick="setRouteFilter('ALL')" type="button">All Areas</button>` +
    allRoutes
      .map(
        (r) =>
          `<button class="pill-btn ${state.routeFilter === r ? "active" : ""}" onclick="setRouteFilter(${jsArg(r)})" type="button">${esc(r)}</button>`
      )
      .join("");

  const holidayBox = document.getElementById("queueHolidayNotice");
  if (queue.is_holiday) {
    holidayBox.classList.remove("hidden");
    holidayBox.textContent = `Holiday today for ${queue.meal_type} (${queue.holiday_reason || "Off"}). Customer plans extended automatically.`;
  } else {
    holidayBox.classList.add("hidden");
  }

  const filteredRoutes = queue.routes.filter(
    (rt) => state.routeFilter === "ALL" || rt.route_area === state.routeFilter
  );

  const qList = document.getElementById("deliveryQueueList");
  if (filteredRoutes.length === 0) {
    qList.innerHTML = `<div class="card muted">No deliveries scheduled for ${esc(queue.meal_type)} here.</div>`;
  } else {
    qList.innerHTML = filteredRoutes
      .map(
        (rt) => `
        <div class="route-section">
          <div class="route-label">
            <span>${esc(rt.route_area)}</span>
            <span class="muted">${rt.left_to_deliver} left of ${rt.total}</span>
          </div>
          ${rt.items.map((item) => renderQueueCard(item, queue.meal_type)).join("")}
        </div>
      `
      )
      .join("");
  }

  // Customers page
  document.getElementById("customerCountBadge").textContent = d.customers.length;
  const expBanner = document.getElementById("expiringAlertBanner");
  if (d.expiring_soon.length > 0) {
    expBanner.classList.remove("hidden");
    expBanner.textContent = `Low balance (≤3 diets): ${d.expiring_soon.map((c) => `${c.name} (${c.diets_remaining})`).join(", ")}`;
  } else {
    expBanner.classList.add("hidden");
  }

  const term = state.customerSearch.trim().toLowerCase();
  const matchedCustomers = d.customers.filter(
    (c) =>
      !term ||
      c.name.toLowerCase().includes(term) ||
      c.phone.includes(term) ||
      (c.route_area || "").toLowerCase().includes(term)
  );

  const cList = document.getElementById("customersList");
  if (matchedCustomers.length === 0) {
    cList.innerHTML = `<div class="card muted">No customers match "${esc(state.customerSearch)}".</div>`;
  } else {
    cList.innerHTML = matchedCustomers
      .map(
        (c) => `
        <div class="item-card">
          <div class="row-between">
            <div>
              <div class="item-title">${esc(c.name)}</div>
              <div class="muted">${esc(c.route_area)} • ${esc(PLAN_LABELS[c.plan_type] || c.plan_type)}</div>
            </div>
            <button class="btn btn-soft btn-sm" onclick="openCustomerActions(${Number(c.id)})" type="button">Manage</button>
          </div>
          <div class="row-between muted">
            <span><strong>${esc(c.diets_remaining)}</strong> / ${esc(c.total_diets)} diets left</span>
            <span>Ends <strong>${formatDate(c.estimated_end_date)}</strong></span>
            <span><strong>${c.boxes_with_customer}</strong> box${c.boxes_with_customer === 1 ? "" : "es"}</span>
          </div>
        </div>
      `
      )
      .join("");
  }

  // QR & Menu page
  document.getElementById("providerQrText").textContent = d.provider_qr_code;

  const lm = document.getElementById("lunchMenuInput");
  const dm = document.getElementById("dinnerMenuInput");
  if (document.activeElement !== lm) lm.value = d.menus.lunch || "";
  if (document.activeElement !== dm) dm.value = d.menus.dinner || "";

  // Setup / More page
  const lcIn = document.getElementById("lunchCutoffInput");
  const dcIn = document.getElementById("dinnerCutoffInput");
  if (document.activeElement !== lcIn) lcIn.value = d.cutoffs.lunch;
  if (document.activeElement !== dcIn) dcIn.value = d.cutoffs.dinner;

  const hList = document.getElementById("holidaysList");
  hList.innerHTML =
    d.holidays.length === 0
      ? `<div class="muted">No holidays scheduled.</div>`
      : d.holidays
          .map(
            (h) => `
          <div class="item-card">
            <div class="row-between">
              <div>
                <strong>${formatDate(h.holiday_date)}</strong>
                <span class="badge badge-holiday">${esc(h.meal_scope.replace("_", " "))}</span>
                <div class="muted">${esc(h.reason || "Holiday")}</div>
              </div>
              <button class="btn btn-soft btn-sm" onclick="deleteHoliday(${Number(h.id)})" type="button">Remove</button>
            </div>
          </div>
        `
          )
          .join("");

  const logsList = document.getElementById("auditLogsList");
  const merged = [
    ...d.recent_logs
      .filter((l) => l.status === "delivered")
      .slice(0, 8)
      .map((l) => ({
        title: `${l.customer_name} • ${l.meal_type}`,
        sub: `QR scanned ${formatDateTime(l.delivered_at)}`,
        badge: "delivered",
      })),
    ...d.payments.slice(0, 6).map((p) => ({
      title: `${p.customer_name} paid ₹${p.amount}`,
      sub: `+${p.diets_added} diets on ${formatDate(p.paid_at)}`,
      badge: "confirmed",
    })),
  ];
  logsList.innerHTML =
    merged.length === 0
      ? `<div class="muted">No recent deliveries or payments.</div>`
      : merged
          .map(
            (m) => `
          <div class="item-card">
            <div class="row-between">
              <div>
                <strong>${esc(m.title)}</strong>
                <div class="muted">${esc(m.sub)}</div>
              </div>
              <span class="badge badge-${esc(m.badge)}">${esc(m.badge)}</span>
            </div>
          </div>
        `
          )
          .join("");
}

function renderCustomerView(s) {
  const loginCard = document.getElementById("customerLoginCard");
  const portal = document.getElementById("customerPortal");

  const demoCustomers = state.demo && state.demo.enabled ? state.demo.customers || [] : [];
  document.getElementById("demoLoginSection").classList.toggle("hidden", demoCustomers.length === 0);
  document.getElementById("demoLoginPills").innerHTML = demoCustomers
    .map(
      (c) =>
        `<button class="btn btn-soft btn-sm" type="button" onclick="quickDemoLogin(${jsArg(c.phone)}, ${jsArg(c.pin)})">${esc(c.name)} (${esc(c.phone)} • PIN ${esc(c.pin)})</button>`
    )
    .join("");
  document
    .getElementById("simulateScanBtn")
    .classList.toggle("hidden", !(state.demo && state.demo.enabled && state.demo.provider_qr_code));

  const customer = s ? s.customer : null;
  if (!customer) {
    loginCard.classList.remove("hidden");
    portal.classList.add("hidden");
    renderBottomNavs();
    return;
  }

  loginCard.classList.add("hidden");
  portal.classList.remove("hidden");
  renderBottomNavs();

  const plan = s.plan;
  document.getElementById("custHeaderName").textContent = `Hi, ${customer.name}`;
  document.getElementById("custHeaderMeta").textContent = `${customer.route_area} • ${customer.address}`;

  document.getElementById("custDietsLeft").textContent = plan ? plan.diets_remaining : 0;
  document.getElementById("custEndDate").textContent = plan ? formatDate(plan.estimated_end_date) : "-";
  document.getElementById("custBoxesHeld").textContent = customer.boxes_with_customer;
  document.getElementById("customerPlanSummary").textContent = plan
    ? `${PLAN_LABELS[plan.plan_type]} • Paid ₹${plan.amount_paid} (${plan.diets_consumed} of ${plan.total_diets} used)`
    : "No active plan. Ask your provider to renew.";

  document.getElementById("customerMenus").innerHTML = `
    <div class="menu-box">
      <strong>Lunch</strong>
      <div>${esc(s.menus.lunch || "Not published yet")}</div>
    </div>
    <div class="menu-box">
      <strong>Dinner</strong>
      <div>${esc(s.menus.dinner || "Not published yet")}</div>
    </div>
  `;

  const mealsToShow = Object.keys(s.today_meals || {});
  document.getElementById("openScannerLunchBtn").classList.toggle("hidden", !mealsToShow.includes("lunch"));
  document.getElementById("openScannerDinnerBtn").classList.toggle("hidden", !mealsToShow.includes("dinner"));

  const todayHoliday = (s.upcoming_holidays || []).find((h) => h.holiday_date === s.today);
  const todayMealsEl = document.getElementById("customerTodayMeals");
  todayMealsEl.innerHTML = mealsToShow
    .map((meal) => {
      const m = s.today_meals[meal];
      const status = m.status;
      const deliveredAt = m.delivered_at ? formatDateTime(m.delivered_at) : "";
      const locked = status === "delivered" || status === "holiday" || m.is_locked;

      return `
        <div class="item-card">
          <div class="row-between">
            <div>
              <strong style="text-transform:capitalize;">Today's ${esc(meal)}</strong>
              <div class="muted">${
                status === "holiday"
                  ? `Holiday (${esc((todayHoliday && todayHoliday.reason) || "Off")}) — End date extended`
                  : status === "delivered"
                  ? `Received at ${esc(deliveredAt)}`
                  : m.is_locked
                  ? `${esc(m.lock_reason)}`
                  : status === "cancelled" || status === "paused"
                  ? `${status === "paused" ? "Paused" : "Cancelled"} — End date extended`
                  : `Confirm before ${esc(s.cutoffs[meal])}`
              }</div>
            </div>
            <span class="badge badge-${esc(status)}">${esc(status)}</span>
          </div>
          ${
            locked
              ? ""
              : `<div class="grid-2">
                  <button class="btn btn-green btn-sm" onclick="respondMeal(${Number(customer.id)}, ${jsArg(s.today)}, ${jsArg(meal)}, true)">Yes, Send</button>
                  <button class="btn btn-red btn-sm" onclick="respondMeal(${Number(customer.id)}, ${jsArg(s.today)}, ${jsArg(meal)}, false)">Cancel</button>
                </div>`
          }
        </div>
      `;
    })
    .join("");

  const history = s.history || [];
  const historyEl = document.getElementById("customerHistoryList");
  historyEl.innerHTML =
    history.length === 0
      ? `<div class="card muted">No deliveries or cancellations yet.</div>`
      : history
          .map(
            (h) => `
          <div class="item-card">
            <div class="row-between">
              <div>
                <strong>${formatDate(h.meal_date)} • ${esc(h.meal_type.toUpperCase())}</strong>
                <div class="muted">${
                  h.delivered_at
                    ? `Received ${formatDateTime(h.delivered_at)}`
                    : h.responded_at
                    ? `Updated ${formatDateTime(h.responded_at)}`
                    : ""
                }</div>
              </div>
              <span class="badge badge-${esc(h.status)}">${esc(h.status)}</span>
            </div>
          </div>
        `
          )
          .join("");
}

function setRouteFilter(route) {
  state.routeFilter = route;
  renderProviderView(state.dashboard);
}

function openCustomerActions(customerId) {
  const c = state.dashboard && state.dashboard.customers.find((x) => x.id === customerId);
  if (!c) return;
  state.actionCustomerId = customerId;
  document.getElementById("actionCustName").textContent = c.name;
  document.getElementById("actionCustSub").textContent = `${c.phone} • ${c.route_area}`;
  document.getElementById("actionCustStats").innerHTML =
    `<strong>${esc(c.diets_remaining)}</strong> diets left • Ends <strong>${formatDate(c.estimated_end_date)}</strong> • <strong>${esc(c.boxes_with_customer)}</strong> empty box(es) held`;
  document.getElementById("customerActionModal").classList.remove("hidden");
}

function closeCustomerActions() {
  document.getElementById("customerActionModal").classList.add("hidden");
}

function checkForPopupTrigger() {
  const s = state.summary;
  if (!s || !s.customer || state.mode !== "customer") return;

  const openable = (meal) => {
    const m = s.today_meals[meal];
    return m && !m.is_locked && m.status !== "holiday";
  };

  if (s.popup_broadcast && s.popup_broadcast !== state.lastBroadcastSeen) {
    state.lastBroadcastSeen = s.popup_broadcast;
    const [mealType] = s.popup_broadcast.split("|");
    if (openable(mealType)) {
      openMealPopup(mealType);
      return;
    }
  }

  if (!checkForPopupTrigger._dismissedThisSession) {
    for (const meal of ["lunch", "dinner"]) {
      if (openable(meal) && s.today_meals[meal].status === "pending") {
        openMealPopup(meal);
        break;
      }
    }
  }
}

function openMealPopup(mealType) {
  const s = state.summary;
  if (!s || !s.customer) return;

  state.popupMealType = mealType;
  document.getElementById("popupTitle").textContent = `Do you want ${mealType.toUpperCase()} today?`;
  document.getElementById("popupMenuBox").innerHTML =
    `<strong>Today's ${esc(mealType)} menu:</strong> ${esc(s.menus[mealType] || "Chef's special")}`;
  document.getElementById("popupDesc").textContent = s.plan
    ? `${s.plan.diets_remaining} diets left • Ends ${formatDate(s.plan.estimated_end_date)} • Cutoff ${s.cutoffs[mealType]}`
    : `Cutoff ${s.cutoffs[mealType]}`;
  document.getElementById("mealPopupModal").classList.remove("hidden");
}

async function loginCustomer(phone, pin) {
  try {
    const res = await api("/api/customer/login", {
      method: "POST",
      body: JSON.stringify({ phone, pin }),
    });
    setCustomerAuth({ token: res.token, id: res.customer.id });
    state.loggedInCustomerId = res.customer.id;
    document.getElementById("loginPin").value = "";
    checkForPopupTrigger._dismissedThisSession = false;
    setCustomerTab("home");
    showToast(`Welcome, ${res.customer.name}`);
    await loadDashboard();
  } catch (err) {
    showToast(err.message);
  }
}

async function loginProvider(pin) {
  try {
    const res = await api("/api/provider/login", {
      method: "POST",
      body: JSON.stringify({ pin }),
    });
    setProviderToken(res.token);
    document.getElementById("providerPinInput").value = "";
    await loadDashboard();
  } catch (err) {
    showToast(err.message);
  }
}

function signOutCustomer() {
  const auth = state.customerAuth;
  if (auth && auth.id === state.loggedInCustomerId) {
    api("/api/auth/logout", { method: "POST", token: auth.token }).catch(() => {});
    setCustomerAuth(null);
  }
  state.loggedInCustomerId = null;
  state.summary = null;
  render();
}

function signOutProvider() {
  if (state.providerToken) {
    api("/api/auth/logout", { method: "POST", token: state.providerToken }).catch(() => {});
  }
  setProviderToken(null);
  if (!state.customerAuth || state.customerAuth.id !== state.loggedInCustomerId) {
    state.loggedInCustomerId = null;
    state.summary = null;
  }
  render();
}

function quickDemoLogin(phone, pin) {
  document.getElementById("loginPhone").value = phone;
  loginCustomer(phone, pin);
}

// The link only pre-fills the phone number; the customer still types their PIN.
async function copyMagicLink(phone) {
  const url = `${window.location.origin}/?mode=customer&phone=${encodeURIComponent(phone)}`;
  try {
    await navigator.clipboard.writeText(url);
    showToast("Customer login link copied!");
  } catch (_) {
    prompt("Copy this customer login link:", url);
  }
}

async function resetCustomerPin(customerId) {
  const c = state.dashboard && state.dashboard.customers.find((x) => x.id === customerId);
  if (!c) return;
  if (!confirm(`Give ${c.name} a new PIN? Their current PIN stops working and their devices are signed out.`)) return;
  try {
    const res = await providerApi(`/api/customers/${customerId}/reset-pin`, { method: "POST", body: "{}" });
    alert(`New PIN for ${c.name}: ${res.pin}\n\nShare it with the customer now. It won't be shown again.`);
  } catch (err) {
    showToast(err.message);
  }
}

async function respondMeal(customerId, mealDate, mealType, wantsTiffin) {
  try {
    const res = await customerApi("/api/meals/respond", {
      method: "POST",
      body: JSON.stringify({
        customer_id: customerId,
        meal_date: mealDate,
        meal_type: mealType,
        wants_tiffin: wantsTiffin,
      }),
    });
    document.getElementById("mealPopupModal").classList.add("hidden");
    showToast(
      wantsTiffin
        ? `${mealType.toUpperCase()} confirmed!`
        : `Cancelled — End date moved to ${formatDate(res.estimated_end_date)}`
    );
    await loadDashboard();
  } catch (err) {
    showToast(err.message);
  }
}

async function manualDeliver(customerId, mealType, boxReturned) {
  try {
    const res = await providerApi("/api/meals/manual-deliver", {
      method: "POST",
      body: JSON.stringify({
        customer_id: customerId,
        meal_date: state.dashboard.today,
        meal_type: mealType,
        box_returned: boxReturned,
      }),
    });
    showToast(`Delivered! Boxes held: ${res.boxes_with_customer}`);
    await loadDashboard();
  } catch (err) {
    showToast(err.message);
  }
}

async function adjustBox(customerId, delta) {
  try {
    const res = await providerApi(`/api/customers/${customerId}/boxes`, {
      method: "POST",
      body: JSON.stringify({ delta }),
    });
    showToast(`Boxes held updated to ${res.boxes_with_customer}`);
    await loadDashboard();
    if (!document.getElementById("customerActionModal").classList.contains("hidden")) {
      openCustomerActions(customerId);
    }
  } catch (err) {
    showToast(err.message);
  }
}

async function triggerBroadcast(mealType) {
  try {
    await providerApi("/api/popup-broadcast", {
      method: "POST",
      body: JSON.stringify({ meal_type: mealType }),
    });
    if ("Notification" in window && Notification.permission === "granted") {
      const reg = await navigator.serviceWorker?.getRegistration();
      const menu = state.dashboard?.menus?.[mealType] || "";
      const title = `Do you want ${mealType.toUpperCase()} today?`;
      const opts = {
        body: menu ? `Menu: ${menu}` : "Tap to confirm or cancel.",
        icon: "/icon.svg",
        data: { mealType },
      };
      if (reg) {
        await reg.showNotification(title, opts);
      } else {
        new Notification(title, opts);
      }
    }
    showToast(`${mealType.toUpperCase()} pop-up sent to customers!`);
    await loadDashboard();
  } catch (err) {
    showToast(err.message);
  }
}

async function deleteHoliday(id) {
  try {
    await providerApi(`/api/holidays/${id}`, { method: "DELETE" });
    showToast("Holiday removed");
    await loadDashboard();
  } catch (err) {
    showToast(err.message);
  }
}

function openRenewModal(customerId) {
  const c = state.dashboard.customers.find((x) => x.id === customerId);
  if (!c) return;
  document.getElementById("renewCustomerId").value = c.id;
  document.getElementById("renewTitle").textContent = `Add Diets — ${c.name}`;
  document.getElementById("renewPlanType").value = c.plan_type;
  document.getElementById("renewModal").classList.remove("hidden");
}

async function openQrScanner(mealType) {
  state.scannerMealType = mealType;
  document.getElementById("scannerTitle").textContent = `Scan QR (${mealType.toUpperCase()})`;
  document.getElementById("qrScannerModal").classList.remove("hidden");
  const statusEl = document.getElementById("scannerStatus");
  const video = document.getElementById("qrVideo");

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    statusEl.textContent = "Camera unavailable here. Use Demo Scan or enter code below.";
    return;
  }

  try {
    state.videoStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
    video.srcObject = state.videoStream;
    if ("BarcodeDetector" in window) {
      const detector = new BarcodeDetector({ formats: ["qr_code"] });
      statusEl.textContent = "Point camera at the tiffin QR code...";
      state.scanTimer = setInterval(async () => {
        try {
          const codes = await detector.detect(video);
          if (codes.length > 0) {
            await submitQrToken(codes[0].rawValue);
          }
        } catch (_) {
          // Ignore single frame decode errors.
        }
      }, 450);
    } else {
      statusEl.textContent = "Camera active (use Demo Scan or enter code below if auto-scan doesn't trigger).";
    }
  } catch (_) {
    statusEl.textContent = "Camera blocked/unavailable. Use Demo Scan or enter code below.";
  }
}

function closeQrScanner() {
  clearInterval(state.scanTimer);
  state.scanTimer = null;
  if (state.videoStream) {
    state.videoStream.getTracks().forEach((t) => t.stop());
    state.videoStream = null;
  }
  document.getElementById("qrScannerModal").classList.add("hidden");
}

async function submitQrToken(token) {
  try {
    const boxReturned = document.getElementById("boxReturnedChk").checked;
    const res = await customerApi("/api/meals/scan-qr", {
      method: "POST",
      body: JSON.stringify({
        customer_id: state.loggedInCustomerId,
        meal_date: state.summary.today,
        meal_type: state.scannerMealType,
        qr_token: token,
        box_returned: boxReturned,
      }),
    });
    closeQrScanner();
    showToast(`Delivered! ${res.diets_remaining} diets left`);
    await loadDashboard();
  } catch (err) {
    showToast(err.message);
  }
}

function bindEvents() {
  document.getElementById("modeProviderBtn").addEventListener("click", () => setMode("provider"));
  document.getElementById("modeCustomerBtn").addEventListener("click", () => {
    checkForPopupTrigger._dismissedThisSession = false;
    setMode("customer");
  });

  document.querySelectorAll("[data-ptab]").forEach((btn) => {
    btn.addEventListener("click", () => setProviderTab(btn.dataset.ptab));
  });
  document.querySelectorAll("[data-ctab]").forEach((btn) => {
    btn.addEventListener("click", () => setCustomerTab(btn.dataset.ctab));
  });

  document.querySelectorAll("[data-queue]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.activeQueue = btn.dataset.queue;
      document.querySelectorAll("[data-queue]").forEach((b) => b.classList.toggle("active", b === btn));
      renderProviderView(state.dashboard);
    });
  });

  document.getElementById("customerSearchInput").addEventListener("input", (e) => {
    state.customerSearch = e.target.value;
    renderProviderView(state.dashboard);
  });

  document.getElementById("openAddCustomerBtn").addEventListener("click", () => {
    document.getElementById("addCustomerModal").classList.remove("hidden");
  });
  document.getElementById("closeAddCustomerBtn").addEventListener("click", () => {
    document.getElementById("addCustomerModal").classList.add("hidden");
  });

  document.getElementById("closeActionModalBtn").addEventListener("click", closeCustomerActions);
  document.getElementById("actionRenewBtn").addEventListener("click", () => {
    closeCustomerActions();
    openRenewModal(state.actionCustomerId);
  });
  document.getElementById("actionBoxReturnBtn").addEventListener("click", () => adjustBox(state.actionCustomerId, -1));
  document.getElementById("actionBoxAddBtn").addEventListener("click", () => adjustBox(state.actionCustomerId, 1));
  document.getElementById("actionCopyLinkBtn").addEventListener("click", () => {
    const c = state.dashboard && state.dashboard.customers.find((x) => x.id === state.actionCustomerId);
    if (c) copyMagicLink(c.phone);
  });
  document.getElementById("actionResetPinBtn").addEventListener("click", () => resetCustomerPin(state.actionCustomerId));
  document.getElementById("actionPreviewBtn").addEventListener("click", () => {
    state.loggedInCustomerId = state.actionCustomerId;
    closeCustomerActions();
    checkForPopupTrigger._dismissedThisSession = false;
    setCustomerTab("home");
    setMode("customer");
    loadDashboard();
  });

  document.getElementById("enableNotifBtn").addEventListener("click", async () => {
    if (!("Notification" in window)) {
      showToast("Browser notifications not supported; in-app pop-ups are active.");
      return;
    }
    const perm = await Notification.requestPermission();
    showToast(perm === "granted" ? "Phone alerts enabled!" : `Alert status: ${perm}`);
  });

  document.getElementById("rotateQrBtn").addEventListener("click", async () => {
    try {
      await providerApi("/api/qr/rotate", { method: "POST" });
      showToast("New QR code generated");
      await loadDashboard();
    } catch (err) {
      showToast(err.message);
    }
  });

  document.getElementById("menuForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await providerApi("/api/menus", {
        method: "POST",
        body: JSON.stringify({
          menu_date: state.dashboard.today,
          meal_type: "lunch",
          items_text: document.getElementById("lunchMenuInput").value,
        }),
      });
      await providerApi("/api/menus", {
        method: "POST",
        body: JSON.stringify({
          menu_date: state.dashboard.today,
          meal_type: "dinner",
          items_text: document.getElementById("dinnerMenuInput").value,
        }),
      });
      showToast("Today's menu saved!");
      await loadDashboard();
    } catch (err) {
      showToast(err.message);
    }
  });

  document.getElementById("cutoffForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await providerApi("/api/settings/cutoffs", {
        method: "POST",
        body: JSON.stringify({
          lunch_cutoff: document.getElementById("lunchCutoffInput").value,
          dinner_cutoff: document.getElementById("dinnerCutoffInput").value,
        }),
      });
      showToast("Cutoff times saved!");
      await loadDashboard();
    } catch (err) {
      showToast(err.message);
    }
  });

  document.getElementById("addCustomerForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      const res = await providerApi("/api/customers", {
        method: "POST",
        body: JSON.stringify(Object.fromEntries(fd.entries())),
      });
      e.target.reset();
      document.getElementById("addCustomerModal").classList.add("hidden");
      showToast(`Added! Ends ${formatDate(res.estimated_end_date)}`);
      alert(`Customer added. Their login PIN is ${res.pin}.\n\nShare it with the customer now. It won't be shown again.`);
      await loadDashboard();
    } catch (err) {
      showToast(err.message);
    }
  });

  document.getElementById("addHolidayForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await providerApi("/api/holidays", {
        method: "POST",
        body: JSON.stringify(Object.fromEntries(fd.entries())),
      });
      e.target.reset();
      showToast("Holiday added — end dates extended!");
      await loadDashboard();
    } catch (err) {
      showToast(err.message);
    }
  });

  document.getElementById("customerLoginForm").addEventListener("submit", (e) => {
    e.preventDefault();
    loginCustomer(
      document.getElementById("loginPhone").value,
      document.getElementById("loginPin").value
    );
  });

  document.getElementById("customerLogoutBtn").addEventListener("click", signOutCustomer);
  document.getElementById("providerLogoutBtn").addEventListener("click", signOutProvider);
  document.getElementById("providerLoginForm").addEventListener("submit", (e) => {
    e.preventDefault();
    loginProvider(document.getElementById("providerPinInput").value.trim());
  });

  document.getElementById("pauseRangeForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      const res = await customerApi("/api/meals/pause", {
        method: "POST",
        body: JSON.stringify({
          customer_id: state.loggedInCustomerId,
          start_date: document.getElementById("pauseStartDate").value,
          end_date: document.getElementById("pauseEndDate").value,
          meal_scope: document.getElementById("pauseScope").value,
        }),
      });
      showToast(`Paused ${res.paused_meals} meal(s) — Ends ${formatDate(res.estimated_end_date)}`);
      await loadDashboard();
    } catch (err) {
      showToast(err.message);
    }
  });

  document.getElementById("resumeRangeBtn").addEventListener("click", async () => {
    try {
      const res = await customerApi("/api/meals/resume", {
        method: "POST",
        body: JSON.stringify({
          customer_id: state.loggedInCustomerId,
          start_date: document.getElementById("pauseStartDate").value,
          end_date: document.getElementById("pauseEndDate").value,
        }),
      });
      showToast(`Resumed ${res.resumed_meals} meal(s) — Ends ${formatDate(res.estimated_end_date)}`);
      await loadDashboard();
    } catch (err) {
      showToast(err.message);
    }
  });

  document.getElementById("popupYesBtn").addEventListener("click", () => {
    respondMeal(state.loggedInCustomerId, state.summary.today, state.popupMealType, true);
  });
  document.getElementById("popupNoBtn").addEventListener("click", () => {
    respondMeal(state.loggedInCustomerId, state.summary.today, state.popupMealType, false);
  });
  document.getElementById("popupDismissBtn").addEventListener("click", () => {
    checkForPopupTrigger._dismissedThisSession = true;
    document.getElementById("mealPopupModal").classList.add("hidden");
  });

  document.getElementById("openScannerLunchBtn").addEventListener("click", () => openQrScanner("lunch"));
  document.getElementById("openScannerDinnerBtn").addEventListener("click", () => openQrScanner("dinner"));
  document.getElementById("closeScannerBtn").addEventListener("click", closeQrScanner);
  document.getElementById("manualQrForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const val = document.getElementById("manualQrInput").value.trim();
    if (val) submitQrToken(val);
  });
  document.getElementById("simulateScanBtn").addEventListener("click", () => {
    if (state.demo && state.demo.provider_qr_code) submitQrToken(state.demo.provider_qr_code);
  });

  document.getElementById("closeRenewBtn").addEventListener("click", () => {
    document.getElementById("renewModal").classList.add("hidden");
  });
  document.getElementById("renewForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const cid = document.getElementById("renewCustomerId").value;
    try {
      const res = await providerApi(`/api/customers/${cid}/renew`, {
        method: "POST",
        body: JSON.stringify({
          plan_type: document.getElementById("renewPlanType").value,
          diets_added: Number(document.getElementById("renewDiets").value),
          amount_paid: Number(document.getElementById("renewAmount").value),
        }),
      });
      document.getElementById("renewModal").classList.add("hidden");
      showToast(`Saved! New end date: ${formatDate(res.estimated_end_date)}`);
      await loadDashboard();
    } catch (err) {
      showToast(err.message);
    }
  });
}

async function handleInitialUrlParams() {
  const params = new URLSearchParams(window.location.search);
  const phone = params.get("phone");
  const mode = params.get("mode");
  if (params.has("pin")) {
    // Old links carried the PIN; drop it from the address bar and history.
    params.delete("pin");
    const qs = params.toString();
    history.replaceState(null, "", `${window.location.pathname}${qs ? `?${qs}` : ""}`);
  }
  if (phone) document.getElementById("loginPhone").value = phone;
  if (phone || mode === "customer") setMode("customer");
}

function restoreSessions() {
  state.providerToken = storeGet(AUTH_KEYS.provider);
  try {
    const auth = JSON.parse(storeGet(AUTH_KEYS.customer) || "null");
    if (auth && auth.token && Number.isInteger(auth.id)) {
      state.customerAuth = auth;
      state.loggedInCustomerId = auth.id;
    }
  } catch (_) {
    setCustomerAuth(null);
  }
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data && event.data.type === "OPEN_MEAL_POPUP") {
      setMode("customer");
      openMealPopup(event.data.mealType || "lunch");
    }
  });
}

bindEvents();
setProviderTab("deliveries");
restoreSessions();
loadDemoInfo()
  .then(loadDashboard)
  .then(handleInitialUrlParams);
