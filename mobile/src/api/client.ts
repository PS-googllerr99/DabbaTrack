import type {
  AuthTokens,
  CustomerIdentity,
  CustomerSummary,
  Dashboard,
  DemoInfo,
  HolidayScope,
  MealPromptResult,
  MealType,
  PauseScope,
  PlanType,
  ScanResult,
} from "./types";

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

const TIMEOUT_MS = 15000;

export function normalizeBaseUrl(raw: string): string {
  let url = raw.trim();
  if (!url) return url;
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
  return url.replace(/\/+$/, "");
}

/**
 * Thin typed wrapper around the DabbaTrack JSON API.
 * `token` is sent as a Bearer token; `onUnauthorized` runs when the server rejects it (expired / revoked).
 */
export class ApiClient {
  readonly baseUrl: string;
  private readonly token: string | null;
  private readonly onUnauthorized?: () => void;

  constructor(baseUrl: string, token: string | null = null, onUnauthorized?: () => void) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.token = token;
    this.onUnauthorized = onUnauthorized;
  }

  private async request<T>(path: string, init: RequestInit = {}, authed = true): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const sendToken = authed && this.token;
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          ...(sendToken ? { Authorization: `Bearer ${this.token}` } : {}),
          ...(init.headers ?? {}),
        },
        signal: controller.signal,
      });
    } catch (err) {
      const aborted = err instanceof Error && err.name === "AbortError";
      throw new ApiError(
        aborted
          ? `Server did not respond within ${TIMEOUT_MS / 1000}s (${this.baseUrl})`
          : `Cannot reach server at ${this.baseUrl}. Check the Base URL in Settings.`,
        0,
      );
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    let data: unknown = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        throw new ApiError(`Unexpected response from server (HTTP ${res.status})`, res.status);
      }
    }
    if (!res.ok) {
      const msg =
        data && typeof data === "object" && "error" in data ? String((data as { error: unknown }).error) : `HTTP ${res.status}`;
      if (res.status === 401 && sendToken) this.onUnauthorized?.();
      throw new ApiError(msg, res.status);
    }
    return data as T;
  }

  private post<T>(path: string, body: object = {}, authed = true): Promise<T> {
    return this.request<T>(path, { method: "POST", body: JSON.stringify(body) }, authed);
  }

  // ---- shared ----
  health() {
    return this.request<{ ok: boolean; time: string }>("/api/health", {}, false);
  }
  demoInfo() {
    return this.request<DemoInfo>("/api/demo", {}, false);
  }

  // ---- auth ----
  customerLogin(phone: string, pin: string) {
    return this.post<{ customer: CustomerIdentity } & AuthTokens>("/api/customer/login", { phone, pin }, false);
  }
  providerLogin(pin: string) {
    return this.post<{ provider: boolean } & AuthTokens>("/api/provider/login", { pin }, false);
  }
  logout() {
    return this.post<{ signed_out: boolean }>("/api/auth/logout");
  }
  changeProviderPin(current_pin: string, new_pin: string) {
    return this.post<{ updated: boolean }>("/api/provider/pin", { current_pin, new_pin });
  }

  // ---- customer ----
  customerSummary(customerId: number) {
    return this.request<CustomerSummary>(`/api/customers/${customerId}/summary`);
  }
  registerPushToken(customerId: number, token: string | null) {
    return this.post("/api/customers/push-token", { customer_id: customerId, expo_push_token: token ?? "" });
  }
  respondToMeal(customerId: number, mealType: MealType, wantsTiffin: boolean, mealDate?: string) {
    return this.post<{ status: string; estimated_end_date: string }>("/api/meals/respond", {
      customer_id: customerId,
      meal_type: mealType,
      wants_tiffin: wantsTiffin,
      ...(mealDate ? { meal_date: mealDate } : {}),
    });
  }
  scanQr(customerId: number, mealType: MealType, qrToken: string, boxReturned: boolean) {
    return this.post<ScanResult>("/api/meals/scan-qr", {
      customer_id: customerId,
      meal_type: mealType,
      qr_token: qrToken,
      box_returned: boxReturned,
    });
  }
  pause(customerId: number, startDate: string, endDate: string, mealScope: PauseScope) {
    return this.post<{ paused_meals: number; skipped_locked: number; estimated_end_date: string }>("/api/meals/pause", {
      customer_id: customerId,
      start_date: startDate,
      end_date: endDate,
      meal_scope: mealScope,
    });
  }
  resume(customerId: number, startDate: string, endDate: string) {
    return this.post<{ resumed_meals: number; estimated_end_date: string }>("/api/meals/resume", {
      customer_id: customerId,
      start_date: startDate,
      end_date: endDate,
    });
  }

  // ---- provider ----
  dashboard() {
    return this.request<Dashboard>("/api/dashboard");
  }
  manualDeliver(customerId: number, mealType: MealType, boxReturned: boolean) {
    return this.post<ScanResult>("/api/meals/manual-deliver", {
      customer_id: customerId,
      meal_type: mealType,
      box_returned: boxReturned,
    });
  }
  adjustBoxes(customerId: number, delta: number) {
    return this.post<{ boxes_with_customer: number }>(`/api/customers/${customerId}/boxes`, { delta });
  }
  addCustomer(input: {
    name: string;
    phone: string;
    address: string;
    route_area: string;
    plan_type: PlanType;
    total_diets: number;
    amount_paid: number;
    /** Leave out to let the server generate one. */
    pin?: string;
  }) {
    return this.post<{ customer_id: number; estimated_end_date: string; pin: string }>("/api/customers", input);
  }
  /** Sets a new PIN (random if omitted) and signs the customer out of their devices. Returns the PIN once. */
  resetCustomerPin(customerId: number, pin?: string) {
    return this.post<{ customer_id: number; pin: string }>(`/api/customers/${customerId}/reset-pin`, pin ? { pin } : {});
  }
  renew(customerId: number, planType: PlanType, dietsAdded: number, amountPaid: number) {
    return this.post<{ estimated_end_date: string }>(`/api/customers/${customerId}/renew`, {
      plan_type: planType,
      diets_added: dietsAdded,
      amount_paid: amountPaid,
    });
  }
  publishMenu(mealType: MealType, itemsText: string, menuDate?: string) {
    return this.post("/api/menus", {
      meal_type: mealType,
      items_text: itemsText,
      ...(menuDate ? { menu_date: menuDate } : {}),
    });
  }
  setCutoffs(lunch: string, dinner: string) {
    return this.post<{ lunch: string; dinner: string }>("/api/settings/cutoffs", {
      lunch_cutoff: lunch,
      dinner_cutoff: dinner,
    });
  }
  addHoliday(date: string, scope: HolidayScope, reason: string) {
    return this.post("/api/holidays", { holiday_date: date, meal_scope: scope, reason });
  }
  removeHoliday(id: number) {
    return this.request(`/api/holidays/${id}`, { method: "DELETE" });
  }
  rotateQr() {
    return this.post<{ provider_qr_code: string }>("/api/qr/rotate");
  }
  sendMealPrompt(mealType: MealType, dryRun = false) {
    return this.post<MealPromptResult>("/api/push/send-meal-prompt", { meal_type: mealType, dry_run: dryRun });
  }
}
