// 功能：登入 Owlting 後台並捕捉 admin API Bearer authorization，供 Admin Rate Inventory Probe 使用。
// 責任：只處理單次登入與 request header 捕捉，不寫 storageState、不輸出 token/cookie、不影響既有訂單同步。
// 關聯模組：runAdminRateInventoryProbe 啟動 Playwright page 後呼叫本模組；scripts/adminRateInventoryProbe.js 提供 chromium。
// 關鍵流程：goto auth login → 填 ODIN_EMAIL/ODIN_PASSWORD → 等待後台 URL → 監聽 admin request → 必要時用 fetch /me 觸發 token。

const LOGIN_URL = "https://auth.owlting.com/project/d0b8b1335b7beb195f5f9b7626e83341/login?redirect=https://api.owlting.com/booking/v2/admin/sso";

function hasCredentials(env = process.env) {
  return Boolean(String(env.ODIN_EMAIL || "").trim() && String(env.ODIN_PASSWORD || "").trim());
}

function buildBaseHeaders({ bearer, lang = "zh_TW" }) {
  return {
    authorization: bearer,
    "x-requested-with": "XMLHttpRequest",
    accept: "application/json, text/javascript, */*; q=0.01",
    "accept-language": lang === "zh_TW" ? "zh-TW,zh;q=0.9,en;q=0.6" : `${lang},zh-TW;q=0.9,en;q=0.6`,
  };
}

async function adminLoginAndCaptureAuth({ page, env = process.env, lang = "zh_TW", timeoutMs = 15000 } = {}) {
  const email = String(env.ODIN_EMAIL || "").trim();
  const password = String(env.ODIN_PASSWORD || "");
  if (!email || !password) {
    const error = new Error("Missing ODIN_EMAIL or ODIN_PASSWORD");
    error.code = "missing_credentials";
    throw error;
  }

  let bearer = "";
  // 中文註解：只在記憶體保存 authorization 並回傳給 request context；任何 log/output 都禁止印出 bearer。
  page.on("request", (req) => {
    try {
      const url = req.url();
      if (!/owlting\.com\/booking\/v2\/admin\//i.test(url)) return;
      const headers = req.headers();
      const value = headers.authorization || headers.Authorization || "";
      if (typeof value === "string" && value.toLowerCase().startsWith("bearer ") && !bearer) bearer = value;
    } catch (_error) {}
  });

  try {
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: Math.max(timeoutMs, 15000) });
    await page.waitForSelector('input[type="password"]', { timeout: Math.max(timeoutMs, 30000) });
    await page.getByRole("textbox", { name: "Email" }).fill(email);
    await page.locator('input[type="password"]').first().fill(password);
    const loginButton = page.locator('button:has-text("登入"), button[type="submit"], input[type="submit"]').first();

    await Promise.all([
      page.waitForURL(/owlting\.com\/booking\/admin/i, { timeout: Math.max(timeoutMs, 60000) }),
      loginButton.click(),
    ]);

    if (!/owlting\.com\/booking\/admin/i.test(page.url())) {
      throw new Error("Login did not reach Owlting booking admin");
    }
  } catch (error) {
    // 中文註解：登入流程錯誤統一標記 login_failed，讓 CLI exit code 與 artifact 分類可預期。
    error.code = "login_failed";
    throw error;
  }

  await page.waitForTimeout(800);
  if (!bearer) {
    const probeUrl = `https://www.owlting.com/booking/v2/admin/me?lang=${encodeURIComponent(lang)}&_=${Date.now()}`;
    await page.evaluate(async (url) => {
      try { await fetch(url, { method: "GET", credentials: "include" }); } catch (_error) {}
    }, probeUrl);
    const deadline = Date.now() + Math.max(2000, Math.min(timeoutMs, 15000));
    while (!bearer && Date.now() < deadline) {
      await page.waitForTimeout(250);
    }
  }

  if (!bearer) {
    const error = new Error("Bearer token not captured");
    error.code = "auth_capture_failed";
    throw error;
  }

  return {
    baseHeaders: buildBaseHeaders({ bearer, lang }),
    authCaptured: true,
  };
}

module.exports = {
  LOGIN_URL,
  adminLoginAndCaptureAuth,
  buildBaseHeaders,
  hasCredentials,
};
