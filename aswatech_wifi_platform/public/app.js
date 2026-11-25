/* =========================================================
   ASWA-TECH SOLUTIONS - WIFI HOTSPOT PLATFORM
   Firebase compat SDK 10.12.2
   Save as: public/app.js

   IMPORTANT:
   - Vouchers created here are stored in Firestore only.
   - Physical MikroTik/Tenda router synchronization is not
     implemented in browser code. It requires a secure backend.
   - Never place router admin passwords or M-Pesa secrets here.
   ========================================================= */
(() => {
  "use strict";

  const auth = window.auth || (window.firebase && firebase.auth());
  const db = window.db || (window.firebase && firebase.firestore());

  const $ = (id) => document.getElementById(id);
  const show = (el) => { if (el) el.hidden = false; };
  const hide = (el) => { if (el) el.hidden = true; };
  const text = (id, value) => { const el = $(id); if (el) el.textContent = value ?? ""; };
  const money = (value) => `KES ${Number(value || 0).toLocaleString("en-KE")}`;
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, c => ({
    "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;"
  })[c]);
  const timestampDate = (v) => {
    if (!v) return null;
    if (v.toDate) return v.toDate();
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  };
  const dateLabel = (v) => {
    const d = timestampDate(v);
    return d ? d.toLocaleString("en-KE") : "Not available";
  };
  const monthStart = (d = new Date()) => new Date(d.getFullYear(), d.getMonth(), 1);
  const nextMonthStart = (d = new Date()) => new Date(d.getFullYear(), d.getMonth() + 1, 1);
  const previousMonthStart = (d = new Date()) => new Date(d.getFullYear(), d.getMonth() - 1, 1);
  const isWithin = (date, start, end) => date && date >= start && date < end;
  const serverTime = () => firebase.firestore.FieldValue.serverTimestamp();
  const API_BASE = String(window.ASWA_API_BASE_URL || "").replace(/\/$/, "");
  let activeSetupRouterId = null;

  if (!auth || !db) {
    console.error("Firebase not initialized. Check firebase-config.js and script order.");
    document.addEventListener("DOMContentLoaded", () => {
      const box = $("authMessage");
      if (box) box.textContent = "Firebase is not initialized. Check firebase-config.js.";
    });
    return;
  }

  const C = {
    users: "users", routers: "routers", packages: "wifiPackages",
    vouchers: "vouchers", sales: "sales"
  };

  let currentUser = null;
  let profile = null;
  let routers = [];
  let packages = [];
  let vouchers = [];
  let sales = [];
  let editingRouterId = null;
  let editingPackageId = null;
  let lastAdminSellerRows = [];

  function message(id, msg, type = "info") {
    const el = $(id);
    if (!el) return;
    el.textContent = msg || "";
    el.className = `message-box ${type}`;
    el.hidden = !msg;
  }

  function setButtonBusy(id, busy, busyText = "Please wait...") {
    const el = $(id);
    if (!el) return;
    if (busy) {
      el.dataset.originalText = el.textContent;
      el.disabled = true;
      el.textContent = busyText;
    } else {
      el.disabled = false;
      if (el.dataset.originalText) el.textContent = el.dataset.originalText;
    }
  }

  function page(name) {
    const ids = ["homeSection", "companyRegistrationSection", "authSection", "dashboardSection"];
    ids.forEach(id => hide($(id)));
    if (name === "home") show($("homeSection"));
    if (name === "company") show($("companyRegistrationSection"));
    if (name === "auth") show($("authSection"));
    if (name === "dashboard") show($("dashboardSection"));
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function authMode(mode) {
    const login = mode === "login";
    if ($("loginPanel")) $("loginPanel").hidden = !login;
    if ($("registerPanel")) $("registerPanel").hidden = login;
    text("authHeading", login ? "Login to Your Account" : "Create Your Seller Account");
    text("authSubheading", login ? "Access your WiFi business dashboard." : "Register your business and verify your email.");
    message("authMessage", "");
    page("auth");
  }

  function showPanel(panelId) {
    document.querySelectorAll(".dashboard-panel").forEach(p => hide(p));
    show($(panelId));
    document.querySelectorAll(".sidebar-link").forEach(b => {
      b.classList.toggle("active", b.dataset.panel === panelId);
    });
    if (panelId === "overviewPanel") refreshOverview();
    if (panelId === "routersPanel") loadRouters();
    if (panelId === "packagesPanel") loadPackages();
    if (panelId === "vouchersPanel") loadVouchers();
    if (panelId === "salesPanel") loadSales();
    if (panelId === "customersPanel") loadCustomers();
    if (panelId === "routerMonitorPanel") renderRouterMonitor();
    if (panelId === "reportsPanel") renderReport();
    if (panelId === "subscriptionPanel") renderSubscription();
    if (panelId === "adminPanel") loadAdminDashboard();
  }

  function sellerIsActive() {
    if (!profile || profile.role !== "seller" || profile.subscriptionStatus !== "active") return false;
    const expiry = timestampDate(profile.subscriptionExpiry);
    return !!expiry && expiry.getTime() > Date.now();
  }

  function isAdmin() { return !!profile && profile.role === "admin"; }

  function requireSellerFeature() {
    if (isAdmin()) return true;
    if (sellerIsActive()) return true;
    message("dashboardMessage", "Your seller subscription is not active. You can view your account and subscription, but router, package, voucher and sales tools are locked until an administrator activates your account.", "warning");
    showPanel("subscriptionPanel");
    return false;
  }

  function updateAccountHeader() {
    text("sellerBusinessName", profile?.businessName || (isAdmin() ? "Platform Administration" : "My Business"));
    text("currentUserEmail", currentUser?.email || "");
    text("roleBadge", isAdmin() ? "Administrator" : "Seller");
    text("overviewBusinessName", profile?.businessName || "—");
    text("overviewEmail", currentUser?.email || "—");
    text("sellerPhoneDisplay", profile?.phone || "—");
    text("overviewRole", isAdmin() ? "Administrator" : "Seller");
    const adminLink = $("adminNavLink");
    if (adminLink) adminLink.hidden = !isAdmin();
    const notice = $("sellerSubscriptionNotice");
    if (notice) notice.hidden = isAdmin() || sellerIsActive();
    if (!isAdmin() && !sellerIsActive()) {
      text("subscriptionStatus", "Pending / Inactive");
    }
  }

  async function readProfile(user) {
    const snap = await db.collection(C.users).doc(user.uid).get();
    if (!snap.exists) throw new Error("Your login is valid, but your seller profile was not found. Contact the platform administrator.");
    return snap.data();
  }

  async function enterDashboard(user) {
    currentUser = user;
    try {
      profile = await readProfile(user);
      if (profile.role !== "admin" && profile.role !== "seller") {
        throw new Error("This account does not have a recognized platform role.");
      }
      page("dashboard");
      updateAccountHeader();
      message("dashboardMessage", "");
      showPanel("overviewPanel");
      if (isAdmin()) await loadAdminDashboard();
      else await refreshOverview();
    } catch (err) {
      console.error("Dashboard/profile loading:", err);
      // Do not silently send the user to the homepage.
      page("auth");
      authMode("login");
      message("authMessage", err.message || "Unable to load your account profile. Please try again.", "error");
    }
  }

  async function login(email, password) {
    const credential = await auth.signInWithEmailAndPassword(email, password);
    const user = credential.user;
    await user.reload();
    const refreshed = auth.currentUser;
    if (!refreshed || !refreshed.emailVerified) {
      message("authMessage", "Please verify your email first. Check your inbox and spam folder, then use Resend Verification Email if needed.", "warning");
      await auth.signOut();
      return;
    }
    await enterDashboard(refreshed);
  }

  async function registerSeller(form) {
    const businessName = $("businessName")?.value.trim();
    const phone = $("registerPhone")?.value.trim();
    const email = $("registerEmail")?.value.trim().toLowerCase();
    const password = $("registerPassword")?.value || "";
    const confirm = $("confirmPassword")?.value || "";
    if (!businessName || !phone || !email || !password) throw new Error("Complete all required fields.");
    if (password.length < 6) throw new Error("Password must contain at least 6 characters.");
    if (password !== confirm) throw new Error("The passwords do not match.");
    if ($("agreeTerms") && !$("agreeTerms").checked) throw new Error("Please accept the terms to continue.");

    const credential = await auth.createUserWithEmailAndPassword(email, password);
    const user = credential.user;
    try {
      await db.collection(C.users).doc(user.uid).set({
        businessName, phone, email, role: "seller", plan: "starter",
        subscriptionStatus: "pending", subscriptionExpiry: null,
        createdAt: serverTime()
      });
      await user.sendEmailVerification();
      await auth.signOut();
      form.reset();
      authMode("login");
      message("authMessage", "Account created. A verification email has been sent. Verify your email, then log in. Your seller subscription will need administrator activation.", "success");
    } catch (err) {
      console.error("Registration profile save failed:", err);
      throw new Error("Your account was created, but the seller profile could not be saved. Ask the administrator to check Firestore permissions before trying to register again. " + (err.message || ""));
    }
  }

  async function resendVerification() {
    const email = $("loginEmail")?.value.trim();
    const password = $("loginPassword")?.value;
    if (!email || !password) throw new Error("Enter your email and password first.");
    const credential = await auth.signInWithEmailAndPassword(email, password);
    await credential.user.sendEmailVerification();
    await auth.signOut();
    message("authMessage", "Verification email sent. Check your inbox and spam folder.", "success");
  }

  async function resetPassword() {
    const email = $("loginEmail")?.value.trim();
    if (!email) throw new Error("Enter your email address in the login email field first.");
    await auth.sendPasswordResetEmail(email);
    message("authMessage", "Password reset email sent. Check your inbox.", "success");
  }

  async function logout() {
    await auth.signOut();
    currentUser = null; profile = null;
    page("home");
  }

  async function getOwned(collection) {
    if (!currentUser) return [];
    const snap = await db.collection(collection).where("ownerId", "==", currentUser.uid).get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  }

  async function apiRequest(path, options = {}) {
    if (!API_BASE) throw new Error("The secure router API URL is not configured. Set it in public/api-config.js first.");
    const user = auth.currentUser;
    if (!user) throw new Error("Please log in again before using router integration.");
    const token = await user.getIdToken(true);
    const response = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}`, ...(options.headers || {}) }
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || payload.message || `Router service returned HTTP ${response.status}`);
    return payload;
  }

  function routerSetupMessage(msg, type = "info") {
    const el = $("routerSetupMessage");
    if (!el) return;
    el.textContent = msg;
    el.className = `message-box ${type}`;
    el.hidden = !msg;
  }

  function openRouterSetup(routerId) {
    const r = routers.find(item => item.id === routerId);
    if (!r) return;
    if (r.routerBrand !== "MikroTik") {
      return message("routerFormMessage", "The first live integration supports MikroTik RouterOS 7.9+. Other brands will use separate model-specific adapters.", "warning");
    }
    activeSetupRouterId = r.id;
    text("routerSetupTitle", `Configure ${r.routerName}`);
    text("routerSetupSubtitle", `${r.routerModel || "MikroTik"} · ${r.routerFirmware || "RouterOS version not recorded"}`);
    text("routerSetupStatus", r.connectionStatus === "connected" ? "Connected — last successful backend test." : "Not connected — complete the setup steps below.");
    if ($("routerTunnelAddress")) $("routerTunnelAddress").value = r.routerTunnelAddress || "";
    if ($("routerApiUsername")) $("routerApiUsername").value = "";
    if ($("routerApiPassword")) $("routerApiPassword").value = "";
    routerSetupMessage("");
    show($("routerSetupWorkspace"));
    $("routerSetupWorkspace")?.scrollIntoView({behavior:"smooth", block:"start"});
  }

  async function saveRouterCredentials() {
    if (!requireSellerFeature() || !activeSetupRouterId) return;
    const tunnelAddress = $("routerTunnelAddress")?.value.trim();
    const username = $("routerApiUsername")?.value.trim();
    const password = $("routerApiPassword")?.value || "";
    if (!tunnelAddress || !username || !password) return routerSetupMessage("Enter the router WireGuard IP, dedicated API username and password.", "error");
    setButtonBusy("saveRouterCredentialsBtn", true, "Encrypting and saving...");
    try {
      const result = await apiRequest(`/api/routers/${encodeURIComponent(activeSetupRouterId)}/credentials`, {
        method: "POST", body: JSON.stringify({ tunnelAddress, username, password })
      });
      if ($("routerApiPassword")) $("routerApiPassword").value = "";
      text("routerSetupStatus", result.message || "Connection details saved securely. Test the connection next.");
      routerSetupMessage("Connection details encrypted and saved on the secure backend. Now test the connection.", "success");
      await loadRouters();
    } catch (err) { routerSetupMessage(err.message, "error"); }
    finally { setButtonBusy("saveRouterCredentialsBtn", false); }
  }

  async function testRouterConnection() {
    if (!requireSellerFeature() || !activeSetupRouterId) return;
    setButtonBusy("testRouterConnectionBtn", true, "Testing router...");
    try {
      const result = await apiRequest(`/api/routers/${encodeURIComponent(activeSetupRouterId)}/test`, { method: "POST", body: "{}" });
      text("routerSetupStatus", `CONNECTED · RouterOS ${result.routerOSVersion || "version detected"} · ${result.boardName || "MikroTik"}`);
      routerSetupMessage("Connection successful. The backend reached the physical MikroTik router. You can now synchronize vouchers.", "success");
      await loadRouters();
    } catch (err) {
      text("routerSetupStatus", "Connection test failed — router remains not connected.");
      routerSetupMessage(err.message, "error");
      await loadRouters();
    } finally { setButtonBusy("testRouterConnectionBtn", false); }
  }

  async function syncVoucherToRouter(voucherId) {
    if (!requireSellerFeature()) return;
    const v = vouchers.find(item => item.id === voucherId);
    if (!v) return;
    if (!confirm(`Send voucher ${v.username} to ${v.routerName || "the selected MikroTik"}?`)) return;
    try {
      const result = await apiRequest(`/api/routers/${encodeURIComponent(v.routerId)}/sync-voucher/${encodeURIComponent(voucherId)}`, { method: "POST", body: "{}" });
      message("voucherFormMessage", result.message || "Voucher synchronized to MikroTik.", "success");
      await loadVouchers();
    } catch (err) { message("voucherFormMessage", "Voucher sync failed: " + err.message, "error"); }
  }

  function setRouterSetupMode(mode) {
    document.querySelectorAll("[data-router-mode]").forEach(btn => btn.classList.toggle("active", btn.dataset.routerMode === mode));
    const guided = $("routerGuidedSetup"), manual = $("routerManualSetup");
    if (guided) guided.hidden = mode === "manual";
    if (manual) manual.hidden = mode === "guided";
  }

  async function loadRouters() {
    if (!requireSellerFeature()) return;
    try {
      routers = await getOwned(C.routers);
      renderRouters();
      populateSelects();
      renderRouterMonitor();
    } catch (err) { message("routerFormMessage", "Could not load routers: " + err.message, "error"); }
  }

  function renderRouters() {
    const el = $("routersList");
    if (!el) return;
    text("routerRegisteredCount", routers.length);
    text("routerConnectedCount", routers.filter(r => r.connectionStatus === "connected").length);
    if (!routers.length) { el.innerHTML = "<p>No routers registered yet.</p>"; return; }
    el.innerHTML = `<div class="data-table-wrap"><table><thead><tr><th>Name / Model</th><th>Brand</th><th>Network address</th><th>Connection</th><th>Actions</th></tr></thead><tbody>${routers.map(r => `
      <tr>
        <td><strong>${esc(r.routerName)}</strong><br><small>${esc(r.routerModel || "Model not specified")}</small></td>
        <td>${esc(r.routerBrand)}</td>
        <td>${esc(r.routerAddress || "Not configured")}</td>
        <td><span class="router-status ${r.connectionStatus === "connected" ? "is-connected" : "is-pending"}">${esc(r.connectionStatus || "not connected")}</span><br><small>${esc(r.routerConnectionMethod || "Not configured")}</small></td>
        <td><button type="button" class="cancel-btn" data-configure-router="${esc(r.id)}">Configure</button>
        <button type="button" class="cancel-btn" data-edit-router="${esc(r.id)}">Edit</button>
        <button type="button" class="cancel-btn" data-delete-router="${esc(r.id)}">Delete</button></td>
      </tr>`).join("")}</tbody></table></div>`;
  }

  async function saveRouter(e) {
    e.preventDefault();
    if (!requireSellerFeature()) return;
    const data = {
      ownerId: currentUser.uid,
      routerName: $("routerName").value.trim(),
      routerBrand: $("routerBrand").value,
      routerLocation: $("routerLocation").value.trim(),
      routerModel: $("routerModel").value.trim(),
      routerAddress: $("routerAddress").value.trim(),
      routerFirmware: $("routerFirmware").value.trim(),
      routerConnectionMethod: $("routerConnectionMethod").value,
      routerNotes: $("routerNotes").value.trim(),
      connectionStatus: editingRouterId ? (routers.find(r => r.id === editingRouterId)?.connectionStatus || "not connected") : "not connected"
    };
    if (!data.routerName || !data.routerBrand) return message("routerFormMessage", "Enter a router name and brand.", "error");
    setButtonBusy("saveRouterBtn", true, "Saving...");
    try {
      if (editingRouterId) {
        await db.collection(C.routers).doc(editingRouterId).update({
          routerName: data.routerName, routerBrand: data.routerBrand,
          routerLocation: data.routerLocation, routerNotes: data.routerNotes,
          routerModel: data.routerModel, routerAddress: data.routerAddress,
          routerFirmware: data.routerFirmware,
          routerConnectionMethod: data.routerConnectionMethod,
          updatedAt: serverTime()
        });
      } else {
        await db.collection(C.routers).add({ ...data, createdAt: serverTime() });
      }
      $("routerForm").reset(); editingRouterId = null;
      hide($("cancelRouterEditBtn"));
      message("routerFormMessage", "Router saved successfully.", "success");
      await loadRouters();
    } catch (err) { message("routerFormMessage", "Unable to save router: " + err.message, "error"); }
    finally { setButtonBusy("saveRouterBtn", false); }
  }

  async function loadPackages() {
    if (!requireSellerFeature()) return;
    try {
      packages = await getOwned(C.packages);
      renderPackages(); populateSelects();
    } catch (err) { message("packageFormMessage", "Could not load packages: " + err.message, "error"); }
  }

  function packagePrice(p) { return Number(p.priceKes ?? p.price ?? 0); }
  function packageDuration(p) { return Number(p.durationHours ?? p.duration ?? 0); }

  function renderPackages() {
    const el = $("packagesList");
    if (!el) return;
    if (!packages.length) { el.innerHTML = "<p>No WiFi packages created yet.</p>"; return; }
    el.innerHTML = `<div class="data-table-wrap"><table><thead><tr><th>Package</th><th>Price</th><th>Duration</th><th>Data</th><th>Actions</th></tr></thead><tbody>${packages.map(p => `
      <tr><td>${esc(p.name)}</td><td>${money(packagePrice(p))}</td><td>${esc(packageDuration(p))} hrs</td><td>${esc(p.dataAllowance || "Unlimited")}</td>
      <td><button type="button" class="cancel-btn" data-edit-package="${esc(p.id)}">Edit</button>
      <button type="button" class="cancel-btn" data-delete-package="${esc(p.id)}">Delete</button></td></tr>`).join("")}</tbody></table></div>`;
  }

  async function savePackage(e) {
    e.preventDefault();
    if (!requireSellerFeature()) return;
    const data = {
      ownerId: currentUser.uid,
      name: $("packageName").value.trim(),
      priceKes: Number($("packagePrice").value),
      durationHours: Number($("packageDuration").value),
      dataAllowance: $("packageDataAllowance").value.trim()
    };
    if (!data.name || data.priceKes <= 0 || data.durationHours <= 0) return message("packageFormMessage", "Enter a name, valid price and duration.", "error");
    setButtonBusy("savePackageBtn", true, "Saving...");
    try {
      if (editingPackageId) {
        await db.collection(C.packages).doc(editingPackageId).update({
          name: data.name, priceKes: data.priceKes, durationHours: data.durationHours,
          dataAllowance: data.dataAllowance, updatedAt: serverTime()
        });
      } else {
        await db.collection(C.packages).add({ ...data, createdAt: serverTime() });
      }
      $("packageForm").reset(); editingPackageId = null;
      hide($("cancelPackageEditBtn"));
      message("packageFormMessage", "Package saved successfully.", "success");
      await loadPackages();
    } catch (err) { message("packageFormMessage", "Unable to save package: " + err.message, "error"); }
    finally { setButtonBusy("savePackageBtn", false); }
  }

  function populateSelects() {
    const routerSelect = $("voucherRouterSelect");
    const voucherPackage = $("voucherPackageSelect");
    const salePackage = $("salePackageSelect");
    if (routerSelect) routerSelect.innerHTML = '<option value="">Select router</option>' + routers.map(r => `<option value="${esc(r.id)}">${esc(r.routerName)} (${esc(r.routerBrand)})</option>`).join("");
    [voucherPackage, salePackage].forEach(sel => {
      if (sel) sel.innerHTML = '<option value="">Select package</option>' + packages.map(p => `<option value="${esc(p.id)}">${esc(p.name)} — ${money(packagePrice(p))}</option>`).join("");
    });
    updateVoucherSummary();
  }

  function updateVoucherSummary() {
    const r = routers.find(x => x.id === $("voucherRouterSelect")?.value);
    const p = packages.find(x => x.id === $("voucherPackageSelect")?.value);
    text("voucherSelectedRouter", r?.routerName || "Not selected");
    text("voucherSelectedPackage", p?.name || "Not selected");
    text("voucherSelectedPrice", p ? money(packagePrice(p)) : "KES 0");
    text("voucherSelectedDuration", p ? `${packageDuration(p)} hours` : "Not selected");
  }

  function randomCode(length = 8) {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, b => chars[b % chars.length]).join("");
  }

  async function generateVouchers(e) {
    e.preventDefault();
    if (!requireSellerFeature()) return;
    const router = routers.find(r => r.id === $("voucherRouterSelect").value);
    const pack = packages.find(p => p.id === $("voucherPackageSelect").value);
    const qty = Number($("voucherQuantity").value);
    if (!router || !pack) return message("voucherFormMessage", "Select a router and WiFi package.", "error");
    if (!Number.isInteger(qty) || qty < 1 || qty > 100) return message("voucherFormMessage", "Enter a quantity from 1 to 100.", "error");
    setButtonBusy("generateVouchersBtn", true, "Generating...");
    try {
      const batch = db.batch();
      const created = [];
      for (let i = 0; i < qty; i++) {
        const username = "AS" + randomCode(7);
        const password = randomCode(8);
        const ref = db.collection(C.vouchers).doc();
        const record = {
          ownerId: currentUser.uid, routerId: router.id, routerName: router.routerName,
          packageId: pack.id, packageName: pack.name, username, password,
          priceKes: packagePrice(pack), durationHours: packageDuration(pack),
          dataAllowance: pack.dataAllowance || "Unlimited",
          status: "unused", syncStatus: "not_synced", createdAt: serverTime()
        };
        batch.set(ref, record);
        created.push({ id: ref.id, ...record, createdAt: new Date() });
      }
      await batch.commit();
      message("voucherFormMessage", `${qty} vouchers generated and saved. They are not yet synchronized to the physical router.`, "success");
      await loadVouchers();
    } catch (err) { message("voucherFormMessage", "Voucher generation failed: " + err.message, "error"); }
    finally { setButtonBusy("generateVouchersBtn", false); }
  }

  async function loadVouchers() {
    if (!requireSellerFeature()) return;
    try {
      vouchers = await getOwned(C.vouchers);
      vouchers.sort((a,b) => (timestampDate(b.createdAt)?.getTime() || 0) - (timestampDate(a.createdAt)?.getTime() || 0));
      renderVouchers();
    } catch (err) { message("voucherFormMessage", "Could not load vouchers: " + err.message, "error"); }
  }

  function renderVouchers() {
    const el = $("vouchersList");
    if (!el) return;
    if (!vouchers.length) { el.innerHTML = "<p>No vouchers generated yet.</p>"; return; }
    el.innerHTML = `<div class="data-table-wrap"><table id="voucherPrintTable"><thead><tr><th>Username</th><th>Password</th><th>Package</th><th>Price</th><th>Status</th><th>Created</th></tr></thead><tbody>${vouchers.map(v => `
      <tr><td>${esc(v.username)}</td><td>${esc(v.password)}</td><td>${esc(v.packageName)}</td><td>${money(v.priceKes)}</td><td>${esc(v.status)}<br><small>${esc(v.syncStatus || "not_synced")}</small></td><td>${esc(dateLabel(v.createdAt))}<br>${v.syncStatus === "synced" ? "<span class=\"router-status is-connected\">On router</span>" : `<button type=\"button\" class=\"cancel-btn\" data-sync-voucher=\"${esc(v.id)}\">Sync to router</button>`}</td></tr>`).join("")}</tbody></table></div>`;
  }

  function downloadCSV(filename, rows) {
    const csv = rows.map(row => row.map(v => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\r\n");
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  }

  function exportVouchers() {
    if (!vouchers.length) return message("voucherFormMessage", "There are no vouchers to export.", "warning");
    downloadCSV("aswatech-vouchers.csv", [
      ["Username","Password","Package","Router","Price KES","Duration Hours","Status"],
      ...vouchers.map(v => [v.username,v.password,v.packageName,v.routerName,v.priceKes,v.durationHours,v.status])
    ]);
  }

  function printVouchers() {
    if (!vouchers.length) return message("voucherFormMessage", "There are no vouchers to print.", "warning");
    const rows = vouchers.map(v => `<tr><td>${esc(v.username)}</td><td>${esc(v.password)}</td><td>${esc(v.packageName)}</td><td>${money(v.priceKes)}</td></tr>`).join("");
    const w = window.open("", "_blank");
    if (!w) return message("voucherFormMessage", "Allow pop-ups to print vouchers.", "warning");
    w.document.write(`<html><head><title>WiFi Vouchers</title><style>body{font-family:Arial;padding:20px}table{width:100%;border-collapse:collapse}th,td{border:1px solid #aaa;padding:8px;text-align:left}h2{color:#123}</style></head><body><h2>ASWA-TECH SOLUTIONS - WiFi Vouchers</h2><table><tr><th>Username</th><th>Password</th><th>Package</th><th>Price</th></tr>${rows}</table><script>window.onload=()=>window.print()<\/script></body></html>`);
    w.document.close();
  }

  async function loadSales() {
    if (!requireSellerFeature()) return;
    try {
      sales = await getOwned(C.sales);
      sales.sort((a,b) => (timestampDate(b.createdAt || b.saleDate)?.getTime() || 0) - (timestampDate(a.createdAt || a.saleDate)?.getTime() || 0));
      renderSales();
    } catch (err) { message("saleFormMessage", "Could not load sales: " + err.message, "error"); }
  }

  function renderSales() {
    const now = new Date(), today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const month = monthStart(now), next = nextMonthStart(now);
    const todayTotal = sales.filter(s => isWithin(timestampDate(s.createdAt || s.saleDate), today, new Date(today.getTime()+86400000))).reduce((n,s) => n + Number(s.amount || s.priceKes || 0), 0);
    const monthRows = sales.filter(s => isWithin(timestampDate(s.createdAt || s.saleDate), month, next));
    const monthTotal = monthRows.reduce((n,s) => n + Number(s.amount || s.priceKes || 0), 0);
    text("todaySalesTotal", money(todayTotal));
    text("salesMonthTotal", money(monthTotal));
    text("salesTransactionsCount", String(sales.length));
    const el = $("salesList");
    if (!el) return;
    if (!sales.length) { el.innerHTML = "<p>No sales recorded yet.</p>"; return; }
    el.innerHTML = `<div class="data-table-wrap"><table><thead><tr><th>Date</th><th>Customer</th><th>Phone</th><th>Package</th><th>Amount</th><th>Payment</th></tr></thead><tbody>${sales.map(s => `
      <tr><td>${esc(dateLabel(s.createdAt || s.saleDate))}</td><td>${esc(s.customerName || "Customer")}</td><td>${esc(s.customerPhone || "—")}</td><td>${esc(s.packageName || "—")}</td><td>${money(s.amount || s.priceKes)}</td><td>${esc(s.paymentMethod || "—")}</td></tr>`).join("")}</tbody></table></div>`;
  }

  async function saveSale(e) {
    e.preventDefault();
    if (!requireSellerFeature()) return;
    const pack = packages.find(p => p.id === $("salePackageSelect").value);
    const amount = Number($("saleAmount").value);
    const customerName = $("saleCustomerName").value.trim();
    const customerPhone = $("saleCustomerPhone").value.trim();
    const paymentMethod = $("salePaymentMethod").value;
    if (!pack || !amount || !customerName || !customerPhone || !paymentMethod) return message("saleFormMessage", "Complete all sale fields.", "error");
    setButtonBusy("saveSaleBtn", true, "Saving...");
    try {
      // customerName is displayed locally but omitted from the stored document
      // because the current Firestore rules allow customerPhone, not customerName.
      await db.collection(C.sales).add({
        ownerId: currentUser.uid, packageId: pack.id, packageName: pack.name,
        amount, priceKes: amount, quantity: 1, paymentMethod,
        status: "completed", customerPhone, sellerName: profile.businessName || "",
        createdAt: serverTime(), saleDate: serverTime()
      });
      $("saleForm").reset();
      message("saleFormMessage", "Sale recorded successfully.", "success");
      await loadSales();
    } catch (err) { message("saleFormMessage", "Could not save sale: " + err.message, "error"); }
    finally { setButtonBusy("saveSaleBtn", false); }
  }

  async function loadCustomers() {
    if (!requireSellerFeature()) return;
    try {
      const rows = await getOwned(C.sales);
      const map = new Map();
      rows.forEach(s => {
        const phone = s.customerPhone || "Unknown";
        if (!map.has(phone)) map.set(phone, { phone, count: 0, total: 0, latest: s.createdAt || s.saleDate });
        const c = map.get(phone); c.count++; c.total += Number(s.amount || s.priceKes || 0);
      });
      const el = $("customersList");
      if (!el) return;
      const customers = [...map.values()].sort((a,b) => b.total - a.total);
      el.innerHTML = customers.length ? `<div class="data-table-wrap"><table><thead><tr><th>Phone</th><th>Transactions</th><th>Total Purchases</th><th>Last Purchase</th></tr></thead><tbody>${customers.map(c => `<tr><td>${esc(c.phone)}</td><td>${c.count}</td><td>${money(c.total)}</td><td>${esc(dateLabel(c.latest))}</td></tr>`).join("")}</tbody></table></div>` : "<p>No customer records yet.</p>";
    } catch (err) { const el=$("customersList"); if(el) el.textContent = "Unable to load customers: " + err.message; }
  }

  function renderRouterMonitor() {
    const el = $("routerMonitorList");
    if (!el) return;
    if (!routers.length) { el.innerHTML = "<p>No registered routers. Add a router first.</p>"; return; }
    el.innerHTML = `<div class="data-table-wrap"><table><thead><tr><th>Router</th><th>Brand</th><th>Location</th><th>Connection status</th></tr></thead><tbody>${routers.map(r => `<tr><td>${esc(r.routerName)}</td><td>${esc(r.routerBrand)}</td><td>${esc(r.routerLocation || "—")}</td><td>${esc(r.connectionStatus || "not connected")}${r.routerOSVersion ? ` · RouterOS ${esc(r.routerOSVersion)}` : ""}</td></tr>`).join("")}</tbody></table></div>`;
  }

  function renderSubscription() {
    const status = isAdmin() ? "Administrator access" : (profile?.subscriptionStatus || "pending");
    text("subscriptionExpiry", isAdmin() ? "No expiry" : dateLabel(profile?.subscriptionExpiry));
    const el = $("subscriptionStatusDetails");
    if (el) {
      const expiry = timestampDate(profile?.subscriptionExpiry);
      const active = sellerIsActive();
      const thisMonthTotal = sales.filter(s => isWithin(timestampDate(s.createdAt || s.saleDate), monthStart(), nextMonthStart())).reduce((n,s) => n + Number(s.amount || 0), 0);
      const fee = thisMonthTotal >= 4000 ? 1500 : 500;
      el.innerHTML = `<h3>${esc(status)}</h3><p>${isAdmin() ? "Administrator accounts bypass seller subscription checks." : active ? "Your seller subscription is active." : "Your account needs administrator activation before seller tools can be used."}</p>
      <p>Monthly sales fee guide: below KES 4,000 = KES 500; KES 4,000 or above = KES 1,500.</p>
      <p>Current month recorded sales: <strong>${money(thisMonthTotal)}</strong></p>
      <p>Indicative fee based on recorded sales: <strong>${money(fee)}</strong></p>`;
    }
    text("subscriptionStatus", status);
  }

  async function refreshOverview() {
    if (!currentUser || !profile) return;
    updateAccountHeader();
    if (isAdmin()) {
      text("subscriptionStatus", "Administrator access");
      return;
    }
    try {
      if (sellerIsActive()) {
        const [r,p,v,s] = await Promise.all([getOwned(C.routers),getOwned(C.packages),getOwned(C.vouchers),getOwned(C.sales)]);
        routers=r; packages=p; vouchers=v; sales=s;
      } else { routers=[]; packages=[]; vouchers=[]; sales=[]; }
      text("routersCount", String(routers.length));
      text("packagesCount", String(packages.length));
      text("vouchersCount", String(vouchers.length));
      const now = new Date();
      const thisTotal = sales.filter(s => isWithin(timestampDate(s.createdAt || s.saleDate), monthStart(now), nextMonthStart(now))).reduce((n,s)=>n+Number(s.amount||0),0);
      const prevTotal = sales.filter(s => isWithin(timestampDate(s.createdAt || s.saleDate), previousMonthStart(now), monthStart(now))).reduce((n,s)=>n+Number(s.amount||0),0);
      text("currentMonthSales", money(thisTotal));
      text("previousMonthSales", money(prevTotal));
      text("estimatedSubscription", money(thisTotal >= 4000 ? 1500 : 500));
      text("subscriptionStatus", sellerIsActive() ? "Active" : (profile.subscriptionStatus || "Pending"));
      renderSubscription();
      populateSelects();
    } catch (err) {
      console.error("Overview load failed:", err);
      message("dashboardMessage", "Some dashboard figures could not load: " + err.message, "warning");
    }
  }

  function renderReport() {
    const el = $("reportSummary");
    if (!el) return;
    const period = $("reportPeriod")?.value || "month";
    const now = new Date();
    let start = new Date(0), end = new Date(now.getTime() + 86400000), label = "All recorded sales";
    if (period === "today") { start = new Date(now.getFullYear(),now.getMonth(),now.getDate()); label = "Today"; }
    if (period === "week") { start = new Date(now.getTime()-7*86400000); label = "Last 7 days"; }
    if (period === "month") { start = monthStart(now); label = "This month"; }
    if (period === "previousMonth") { start = previousMonthStart(now); end = monthStart(now); label = "Previous month"; }
    const rows = sales.filter(s => isWithin(timestampDate(s.createdAt || s.saleDate), start, end));
    const total = rows.reduce((n,s)=>n+Number(s.amount||s.priceKes||0),0);
    el.innerHTML = `<h3>${esc(label)}</h3><p>Transactions: <strong>${rows.length}</strong></p><p>Total sales: <strong>${money(total)}</strong></p>`;
  }

  function exportSales() {
    if (!sales.length) return message("saleFormMessage", "No sales available to export.", "warning");
    downloadCSV("aswatech-sales-report.csv", [
      ["Date","Package","Customer Phone","Amount KES","Payment Method","Status"],
      ...sales.map(s => [dateLabel(s.createdAt || s.saleDate),s.packageName,s.customerPhone,s.amount || s.priceKes,s.paymentMethod,s.status])
    ]);
  }

  async function loadAdminDashboard() {
    if (!isAdmin()) return;
    const el = $("adminSellersList");
    if (el) el.innerHTML = "<p>Loading seller accounts and activity...</p>";
    try {
      const [usersSnap, salesSnap, routersSnap, packagesSnap, vouchersSnap] = await Promise.all([
        db.collection(C.users).get(), db.collection(C.sales).get(),
        db.collection(C.routers).get(), db.collection(C.packages).get(),
        db.collection(C.vouchers).get()
      ]);
      const sellers = usersSnap.docs.map(d => ({ id:d.id, ...d.data() })).filter(u => u.role === "seller");
      const allSales = salesSnap.docs.map(d => ({ id:d.id, ...d.data() }));
      const allRouters = routersSnap.docs.map(d => ({ id:d.id, ...d.data() }));
      const allPackages = packagesSnap.docs.map(d => ({ id:d.id, ...d.data() }));
      const allVouchers = vouchersSnap.docs.map(d => ({ id:d.id, ...d.data() }));
      text("adminTotalSellers", String(sellers.length));
      text("adminTotalSales", money(allSales.reduce((n,s)=>n+Number(s.amount||s.priceKes||0),0)));
      text("adminTotalRouters", String(allRouters.length));
      text("adminTotalVouchers", String(allVouchers.length));
      const now = new Date(), start = monthStart(now), end = nextMonthStart(now);
      lastAdminSellerRows = sellers.map(u => {
        const ss = allSales.filter(s => s.ownerId === u.id);
        const monthly = ss.filter(s => isWithin(timestampDate(s.createdAt || s.saleDate), start, end));
        return {
          user:u, sales:ss, monthlySales:monthly.reduce((n,s)=>n+Number(s.amount||s.priceKes||0),0),
          totalSales:ss.reduce((n,s)=>n+Number(s.amount||s.priceKes||0),0),
          routers:allRouters.filter(r=>r.ownerId===u.id),
          packages:allPackages.filter(p=>p.ownerId===u.id),
          vouchers:allVouchers.filter(v=>v.ownerId===u.id)
        };
      });
      renderAdminSellers();
    } catch (err) {
      console.error("Admin data load failed:", err);
      if (el) el.innerHTML = `<p class="error-text">Could not load admin data: ${esc(err.message)}. Check that this account has role "admin" in users/${esc(currentUser.uid)} and Firestore rules allow admin reads.</p>`;
    }
  }

  function renderAdminSellers() {
    const el = $("adminSellersList");
    if (!el) return;
    const query = ($("adminSellerSearchInput")?.value || "").trim().toLowerCase();
    const matchingRows = lastAdminSellerRows
      .map((row, index) => ({ row, index }))
      .filter(({ row }) => {
        if (!query) return true;
        const u = row.user || {};
        return [u.businessName, u.email, u.phone, u.id, u.subscriptionStatus]
          .join(" ").toLowerCase().includes(query);
      });

    text("adminSellerSearchCount", query
      ? `Showing ${matchingRows.length} of ${lastAdminSellerRows.length} sellers matching “${query}”.`
      : `${lastAdminSellerRows.length} seller account(s).`);

    if (!matchingRows.length) {
      el.innerHTML = '<div class="admin-empty-state">No sellers match your search. Try a different business name, email, phone number or seller ID.</div>';
      return;
    }

    el.innerHTML = matchingRows.map(({ row, index }) => {
      const u = row.user;
      const expiry = dateLabel(u.subscriptionExpiry);
      const status = u.subscriptionStatus || "pending";
      const monthlyTransactions = row.sales.filter(s =>
        isWithin(timestampDate(s.createdAt || s.saleDate), monthStart(), nextMonthStart())
      );
      const statusClass = String(status).toLowerCase().replace(/[^a-z0-9_-]/g, "-");
      const tabPrefix = `seller-${index}`;

      return `
        <article class="admin-seller-card" data-seller-card="${index}">
          <div class="admin-seller-topline">
            <div class="admin-seller-avatar">${esc((u.businessName || "S").trim().charAt(0).toUpperCase())}</div>
            <div class="admin-seller-identity">
              <h3>${esc(u.businessName || "Unnamed business")}</h3>
              <p>${esc(u.email || "No email")}</p>
              <p>${esc(u.phone || "No phone")}</p>
            </div>
            <span class="seller-status-badge status-${statusClass}">${esc(status)}</span>
          </div>

          <div class="seller-quick-stats">
            <div><small>Sales this month</small><strong>${money(row.monthlySales)}</strong></div>
            <div><small>All-time sales</small><strong>${money(row.totalSales)}</strong></div>
            <div><small>Routers</small><strong>${row.routers.length}</strong></div>
            <div><small>Packages</small><strong>${row.packages.length}</strong></div>
          </div>

          <div class="seller-card-meta">
            <span>Subscription expiry: <strong>${esc(expiry)}</strong></span>
            <span>Vouchers: <strong>${row.vouchers.length}</strong></span>
          </div>

          <button type="button" class="seller-details-toggle" data-toggle-seller-details="${index}" aria-expanded="false">
            <span>View seller details</span><span aria-hidden="true">＋</span>
          </button>
          <div class="seller-expanded-details" id="seller-expanded-${index}" hidden>
          <div class="seller-tabs" role="tablist" aria-label="Seller details">
            <button type="button" class="seller-tab-button" data-seller-tab="overview" aria-controls="${tabPrefix}-overview" aria-selected="false">Overview</button>
            <button type="button" class="seller-tab-button" data-seller-tab="routers" aria-controls="${tabPrefix}-routers" aria-selected="false">Routers</button>
            <button type="button" class="seller-tab-button" data-seller-tab="packages" aria-controls="${tabPrefix}-packages" aria-selected="false">Packages</button>
            <button type="button" class="seller-tab-button" data-seller-tab="vouchers" aria-controls="${tabPrefix}-vouchers" aria-selected="false">Vouchers</button>
            <button type="button" class="seller-tab-button" data-seller-tab="sales" aria-controls="${tabPrefix}-sales" aria-selected="false">Sales</button>
          </div>

          <section class="seller-tab-content" id="${tabPrefix}-overview" hidden>
            <h4>Seller account details</h4>
            <div class="seller-info-grid">
              <p><small>Business name</small><strong>${esc(u.businessName || "—")}</strong></p>
              <p><small>Email address</small><strong>${esc(u.email || "—")}</strong></p>
              <p><small>Phone number</small><strong>${esc(u.phone || "—")}</strong></p>
              <p><small>Seller UID</small><strong class="seller-uid">${esc(u.id)}</strong></p>
              <p><small>Subscription status</small><strong>${esc(status)}</strong></p>
              <p><small>Subscription expiry</small><strong>${esc(expiry)}</strong></p>
            </div>
            <div class="seller-fee-note">Suggested monthly subscription from recorded sales: <strong>${money(row.monthlySales >= 4000 ? 1500 : 500)}</strong></div>
          </section>

          <section class="seller-tab-content" id="${tabPrefix}-routers" hidden>
            <h4>Registered routers (${row.routers.length})</h4>
            ${row.routers.length ? `<div class="seller-detail-list">${row.routers.map(r => `
              <div class="seller-detail-item"><strong>${esc(r.routerName || "Unnamed router")}</strong><span>${esc(r.routerBrand || "Unknown brand")}</span><small>${esc(r.routerLocation || "No location")}</small></div>
            `).join("")}</div>` : '<p class="seller-empty-note">No routers registered.</p>'}
          </section>

          <section class="seller-tab-content" id="${tabPrefix}-packages" hidden>
            <h4>WiFi packages (${row.packages.length})</h4>
            ${row.packages.length ? `<div class="seller-detail-list">${row.packages.map(pkg => `
              <div class="seller-detail-item"><strong>${esc(pkg.name || "Unnamed package")}</strong><span>${money(pkg.priceKes ?? pkg.price)}</span><small>${esc(pkg.durationHours ?? pkg.duration ?? "—")} hours · ${esc(pkg.dataAllowance || "No data limit specified")}</small></div>
            `).join("")}</div>` : '<p class="seller-empty-note">No packages registered.</p>'}
          </section>

          <section class="seller-tab-content" id="${tabPrefix}-vouchers" hidden>
            <h4>Generated vouchers (${row.vouchers.length})</h4>
            ${row.vouchers.length ? `<div class="data-table-wrap"><table><thead><tr><th>Username</th><th>Package</th><th>Price</th><th>Status</th></tr></thead><tbody>${row.vouchers.map(v => `
              <tr><td>${esc(v.username || "—")}</td><td>${esc(v.packageName || "—")}</td><td>${money(v.priceKes)}</td><td>${esc(v.status || "—")}</td></tr>
            `).join("")}</tbody></table></div>` : '<p class="seller-empty-note">No vouchers generated.</p>'}
            <p class="seller-security-note">Voucher passwords and router administrator credentials are not displayed in this admin summary.</p>
          </section>

          <section class="seller-tab-content" id="${tabPrefix}-sales" hidden>
            <div class="seller-sales-heading"><div><h4>Sales this month</h4><strong>${money(row.monthlySales)}</strong></div><div><small>Transactions</small><strong>${monthlyTransactions.length}</strong></div></div>
            ${monthlyTransactions.length ? `<div class="data-table-wrap"><table><thead><tr><th>Date</th><th>Package</th><th>Customer phone</th><th>Amount</th></tr></thead><tbody>${monthlyTransactions.map(sale => `
              <tr><td>${esc(dateLabel(sale.createdAt || sale.saleDate))}</td><td>${esc(sale.packageName || "—")}</td><td>${esc(sale.customerPhone || "—")}</td><td>${money(sale.amount || sale.priceKes)}</td></tr>
            `).join("")}</tbody></table></div>` : '<p class="seller-empty-note">No sales recorded this month.</p>'}
            <div class="seller-all-time-total">All-time recorded sales <strong>${money(row.totalSales)}</strong></div>
          </section>

          <div class="seller-admin-actions">
            <button type="button" class="seller-action-activate" data-activate-seller="${index}">Activate 30 Days</button>
            <button type="button" class="seller-action-expiry" data-expiry-seller="${index}">Set Expiry</button>
            <button type="button" class="seller-action-suspend" data-suspend-seller="${index}">Suspend</button>
            <button type="button" class="seller-action-delete" data-delete-seller="${index}">Delete Seller Data</button>
          </div>
          </div>
        </article>`;
    }).join("");
  }

  async function activateSeller(index) {
    const row = lastAdminSellerRows[index]; if (!row) return;
    const expiry = new Date(Date.now() + 30*86400000);
    await db.collection(C.users).doc(row.user.id).update({
      subscriptionStatus:"active", subscriptionExpiry:firebase.firestore.Timestamp.fromDate(expiry)
    });
    await loadAdminDashboard();
  }

  async function setSellerExpiry(index) {
    const row = lastAdminSellerRows[index]; if (!row) return;
    const value = prompt("Enter subscription expiry date (YYYY-MM-DD):");
    if (!value) return;
    const d = new Date(value + "T23:59:59");
    if (Number.isNaN(d.getTime())) return alert("Invalid date. Use YYYY-MM-DD.");
    await db.collection(C.users).doc(row.user.id).update({
      subscriptionStatus: d > new Date() ? "active" : "expired",
      subscriptionExpiry: firebase.firestore.Timestamp.fromDate(d)
    });
    await loadAdminDashboard();
  }

  async function suspendSeller(index) {
    const row = lastAdminSellerRows[index]; if (!row) return;
    if (!confirm(`Suspend ${row.user.businessName || row.user.email}?`)) return;
    await db.collection(C.users).doc(row.user.id).update({ subscriptionStatus:"suspended" });
    await loadAdminDashboard();
  }

  async function deleteSellerData(index) {
    if (!isAdmin()) throw new Error("Administrator access is required.");
    const row = lastAdminSellerRows[index];
    if (!row) throw new Error("Seller record was not found. Refresh the list.");

    const email = row.user.email || row.user.businessName || row.user.id;
    const confirmation = prompt(
      `WARNING: This permanently deletes the seller's Firestore profile, routers, packages, vouchers and sales.\n\nThe Firebase Authentication login account is NOT deleted by this browser action. A secure Admin SDK backend is required for that.\n\nType DELETE to continue for: ${email}`
    );
    if (confirmation !== "DELETE") return;

    const collections = [C.routers, C.packages, C.vouchers, C.sales];
    const docsToDelete = [];

    // Support both current and earlier ownership field names.
    for (const collectionName of collections) {
      const [ownerSnap, sellerSnap] = await Promise.all([
        db.collection(collectionName).where("ownerId", "==", row.user.id).get(),
        db.collection(collectionName).where("sellerId", "==", row.user.id).get()
      ]);
      const unique = new Map();
      ownerSnap.docs.concat(sellerSnap.docs).forEach(doc => unique.set(doc.ref.path, doc.ref));
      docsToDelete.push(...unique.values());
    }

    // Delete in batches below Firestore's 500-write limit.
    for (let i = 0; i < docsToDelete.length; i += 450) {
      const batch = db.batch();
      docsToDelete.slice(i, i + 450).forEach(ref => batch.delete(ref));
      await batch.commit();
    }

    await db.collection(C.users).doc(row.user.id).delete();
    message(
      "adminMessage",
      `Seller Firestore data for ${email} was deleted. The Firebase Authentication login account still exists and must be deleted separately using a secure Admin SDK backend.`,
      "warning"
    );
    await loadAdminDashboard();
  }

  function bindEvents() {
    document.querySelectorAll("[data-open-login]").forEach(b => b.addEventListener("click", () => authMode("login")));
    document.querySelectorAll("[data-open-company-register]").forEach(b => b.addEventListener("click", () => page("company")));
    document.querySelectorAll("[data-company-back-home],[data-back-home]").forEach(b => b.addEventListener("click", () => page("home")));
    document.querySelectorAll("[data-page='home']").forEach(b => b.addEventListener("click", e => { e.preventDefault(); page("home"); }));
    $("showRegisterBtn")?.addEventListener("click", () => authMode("register"));
    $("showLoginBtn")?.addEventListener("click", () => authMode("login"));

    $("loginForm")?.addEventListener("submit", async e => {
      e.preventDefault(); message("authMessage","");
      setButtonBusy("loginBtn",true,"Signing in...");
      try { await login($("loginEmail").value.trim(), $("loginPassword").value); }
      catch(err) { console.error(err); message("authMessage", friendlyAuthError(err), "error"); }
      finally { setButtonBusy("loginBtn",false); }
    });

    $("registerForm")?.addEventListener("submit", async e => {
      e.preventDefault(); message("authMessage","");
      setButtonBusy("registerBtn",true,"Creating account...");
      try { await registerSeller(e.currentTarget); }
      catch(err) { console.error(err); message("authMessage", friendlyAuthError(err), "error"); }
      finally { setButtonBusy("registerBtn",false); }
    });

    $("forgotPasswordBtn")?.addEventListener("click", async () => {
      try { await resetPassword(); } catch(err) { message("authMessage", friendlyAuthError(err), "error"); }
    });
    $("resendVerificationBtn")?.addEventListener("click", async () => {
      try { await resendVerification(); } catch(err) { message("authMessage", friendlyAuthError(err), "error"); }
    });
    $("logoutBtn")?.addEventListener("click", async () => {
      try { await logout(); } catch(err) { alert("Logout failed: " + err.message); }
    });

    document.querySelectorAll(".sidebar-link[data-panel]").forEach(b => b.addEventListener("click", () => {
      const panel = b.dataset.panel;
      if (panel !== "overviewPanel" && panel !== "subscriptionPanel" && panel !== "adminPanel" && !requireSellerFeature()) return;
      showPanel(panel);
    }));

    $("routerForm")?.addEventListener("submit", saveRouter);
    $("saveRouterCredentialsBtn")?.addEventListener("click", saveRouterCredentials);
    $("testRouterConnectionBtn")?.addEventListener("click", testRouterConnection);
    $("closeRouterSetupBtn")?.addEventListener("click", () => { hide($("routerSetupWorkspace")); activeSetupRouterId = null; });
    document.querySelectorAll("[data-router-mode]").forEach(btn => btn.addEventListener("click", () => setRouterSetupMode(btn.dataset.routerMode)));
    $("routersList")?.addEventListener("click", e => {
      const configure = e.target.closest("[data-configure-router]");
      if (configure) openRouterSetup(configure.dataset.configureRouter);
    });
    $("vouchersList")?.addEventListener("click", e => {
      const sync = e.target.closest("[data-sync-voucher]");
      if (sync) syncVoucherToRouter(sync.dataset.syncVoucher);
    });
    $("packageForm")?.addEventListener("submit", savePackage);
    $("voucherForm")?.addEventListener("submit", generateVouchers);
    $("saleForm")?.addEventListener("submit", saveSale);
    $("voucherRouterSelect")?.addEventListener("change", updateVoucherSummary);
    $("voucherPackageSelect")?.addEventListener("change", updateVoucherSummary);
    $("refreshVouchersBtn")?.addEventListener("click", loadVouchers);
    $("exportVouchersBtn")?.addEventListener("click", exportVouchers);
    $("printVouchersBtn")?.addEventListener("click", printVouchers);
    $("refreshSalesBtn")?.addEventListener("click", loadSales);
    $("refreshCustomersBtn")?.addEventListener("click", loadCustomers);
    $("refreshAdminSellersBtn")?.addEventListener("click", loadAdminDashboard);
    $("adminSellerSearchBtn")?.addEventListener("click", renderAdminSellers);
    $("adminSellerSearchInput")?.addEventListener("keydown", event => {
      if (event.key === "Enter") {
        event.preventDefault();
        renderAdminSellers();
      }
    });
    $("adminSellerSearchClearBtn")?.addEventListener("click", () => {
      if ($("adminSellerSearchInput")) $("adminSellerSearchInput").value = "";
      renderAdminSellers();
      $("adminSellerSearchInput")?.focus();
    });
    $("refreshReportBtn")?.addEventListener("click", renderReport);
    $("exportSalesReportBtn")?.addEventListener("click", exportSales);

    $("cancelRouterEditBtn")?.addEventListener("click", () => { editingRouterId=null; $("routerForm").reset(); hide($("cancelRouterEditBtn")); });
    $("cancelPackageEditBtn")?.addEventListener("click", () => { editingPackageId=null; $("packageForm").reset(); hide($("cancelPackageEditBtn")); });

    $("routersList")?.addEventListener("click", async e => {
      const edit = e.target.closest("[data-edit-router]");
      const del = e.target.closest("[data-delete-router]");
      if (edit) {
        const r = routers.find(x=>x.id===edit.dataset.editRouter); if (!r) return;
        editingRouterId=r.id; $("routerName").value=r.routerName||""; $("routerBrand").value=r.routerBrand||"";
        $("routerLocation").value=r.routerLocation||""; $("routerNotes").value=r.routerNotes||"";
        if ($("routerModel")) $("routerModel").value=r.routerModel||"";
        if ($("routerAddress")) $("routerAddress").value=r.routerAddress||"";
        if ($("routerFirmware")) $("routerFirmware").value=r.routerFirmware||"";
        if ($("routerConnectionMethod")) $("routerConnectionMethod").value=r.routerConnectionMethod||"Not configured";
        show($("cancelRouterEditBtn")); $("routerName").focus();
      }
      if (del && confirm("Delete this router?")) {
        try { await db.collection(C.routers).doc(del.dataset.deleteRouter).delete(); await loadRouters(); }
        catch(err) { message("routerFormMessage", "Delete failed: "+err.message,"error"); }
      }
    });

    $("packagesList")?.addEventListener("click", async e => {
      const edit = e.target.closest("[data-edit-package]");
      const del = e.target.closest("[data-delete-package]");
      if (edit) {
        const p = packages.find(x=>x.id===edit.dataset.editPackage); if (!p) return;
        editingPackageId=p.id; $("packageName").value=p.name||""; $("packagePrice").value=packagePrice(p);
        $("packageDuration").value=packageDuration(p); $("packageDataAllowance").value=p.dataAllowance||"";
        show($("cancelPackageEditBtn")); $("packageName").focus();
      }
      if (del && confirm("Delete this package?")) {
        try { await db.collection(C.packages).doc(del.dataset.deletePackage).delete(); await loadPackages(); }
        catch(err) { message("packageFormMessage", "Delete failed: "+err.message,"error"); }
      }
    });

    $("adminSellersList")?.addEventListener("click", async e => {
      // Seller information stays hidden until an admin selects a tab.
      const tabButton = e.target.closest("[data-seller-tab]");
      if (tabButton) {
        const card = tabButton.closest("[data-seller-card]");
        if (card) {
          card.querySelectorAll(".seller-tab-content").forEach(panel => { panel.hidden = true; });
          card.querySelectorAll("[data-seller-tab]").forEach(button => {
            button.classList.remove("active");
            button.setAttribute("aria-selected", "false");
          });
          const index = card.dataset.sellerCard;
          const tabName = tabButton.dataset.sellerTab;
          const selectedPanel = card.querySelector(`#seller-${index}-${tabName}`);
          if (selectedPanel) {
            selectedPanel.hidden = false;
            tabButton.classList.add("active");
            tabButton.setAttribute("aria-selected", "true");
          }
        }
        return;
      }

      const toggle = e.target.closest("[data-toggle-seller-details]");
      if (toggle) {
        const index = toggle.dataset.toggleSellerDetails;
        const panel = $(`seller-expanded-${index}`);
        if (panel) {
          panel.hidden = !panel.hidden;
          const opening = !panel.hidden;
          toggle.setAttribute("aria-expanded", String(opening));
          toggle.innerHTML = opening
            ? '<span>Hide seller details</span><span aria-hidden="true">−</span>'
            : '<span>View seller details</span><span aria-hidden="true">＋</span>';
        }
        return;
      }

      const a=e.target.closest("[data-activate-seller]");
      const x=e.target.closest("[data-expiry-seller]");
      const s=e.target.closest("[data-suspend-seller]");
      const d=e.target.closest("[data-delete-seller]");
      try {
        if (a) await activateSeller(Number(a.dataset.activateSeller));
        if (x) await setSellerExpiry(Number(x.dataset.expirySeller));
        if (s) await suspendSeller(Number(s.dataset.suspendSeller));
        if (d) await deleteSellerData(Number(d.dataset.deleteSeller));
      } catch(err) { alert("Admin action failed: " + err.message); }
    });

    $("reportPeriod")?.addEventListener("change", renderReport);
    $("companySubdomain")?.addEventListener("input", () => {
      const value = $("companySubdomain").value.toLowerCase().replace(/[^a-z]/g,"");
      $("companySubdomain").value=value;
      text("companySubdomainPreview", (value || "yourcompany") + ".ispledger.com");
    });
    $("companyRegistrationForm")?.addEventListener("submit", e => {
      e.preventDefault();
      text("companyRegistrationMessage", "Company registration form captured locally. The company/subdomain registration service and KES 700 payment are not connected yet; no payment has been taken.");
    });
  }

  function friendlyAuthError(err) {
    const code = err?.code || "";
    const messages = {
      "auth/invalid-email":"Enter a valid email address.",
      "auth/user-not-found":"No account was found for this email.",
      "auth/wrong-password":"Incorrect password. Try again or reset your password.",
      "auth/invalid-credential":"Email or password is incorrect.",
      "auth/too-many-requests":"Too many attempts. Wait a while and try again.",
      "auth/email-already-in-use":"This email already has an account. Please log in.",
      "auth/weak-password":"Choose a stronger password with at least 6 characters.",
      "auth/network-request-failed":"Network error. Check your internet connection.",
      "auth/operation-not-allowed":"Email/Password sign-in is not enabled in Firebase Authentication."
    };
    return messages[code] || err?.message || "Something went wrong. Please try again.";
  }

  document.addEventListener("DOMContentLoaded", () => {
    bindEvents();
    page("home");
    // The auth observer deliberately does not force a signed-in but
    // unverified or profile-error user back to Home without explanation.
    auth.onAuthStateChanged(async user => {
      if (!user) {
        currentUser=null; profile=null;
        if ($("dashboardSection") && !$("dashboardSection").hidden) page("home");
        return;
      }
      try {
        await user.reload();
        const refreshed = auth.currentUser;
        if (!refreshed?.emailVerified) {
          page("auth"); authMode("login");
          message("authMessage","Please verify your email address before logging in. Use Resend Verification Email if needed.","warning");
          await auth.signOut();
          return;
        }
        // If a login submit is in progress it will also call this method;
        // profile loading is safe to repeat, and does not redirect to Home.
        if (!profile || currentUser?.uid !== refreshed.uid) await enterDashboard(refreshed);
      } catch (err) {
        console.error("Authentication state handling:",err);
        page("auth"); authMode("login");
        message("authMessage",err.message || "Unable to load your account. Please retry login.","error");
      }
    });
  });
})();
