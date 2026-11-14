/** Types mirroring the DabbaTrack Python API (db.py). */

export type PlanType = "lunch_only" | "dinner_only" | "both";
export type MealType = "lunch" | "dinner";
export type MealStatus = "pending" | "confirmed" | "cancelled" | "paused" | "delivered" | "holiday";
export type HolidayScope = "full_day" | "lunch" | "dinner";
export type PauseScope = "all" | "lunch" | "dinner";

export const PLAN_LABELS: Record<PlanType, string> = {
  lunch_only: "Lunch Only",
  dinner_only: "Dinner Only",
  both: "Lunch + Dinner",
};

export const PLAN_MEALS: Record<PlanType, MealType[]> = {
  lunch_only: ["lunch"],
  dinner_only: ["dinner"],
  both: ["lunch", "dinner"],
};

export interface CustomerIdentity {
  id: number;
  name: string;
  phone: string;
  address: string;
  route_area: string;
  boxes_with_customer: number;
}

export interface Menus {
  lunch: string;
  dinner: string;
}

export interface Cutoffs {
  lunch: string;
  dinner: string;
}

export interface CustomerPlan {
  subscription_id: number;
  plan_type: PlanType;
  total_diets: number;
  diets_consumed: number;
  diets_remaining: number;
  amount_paid: number;
  payment_date: string;
  start_date: string;
  estimated_end_date: string;
}

export interface TodayMeal {
  status: MealStatus;
  responded_at: string | null;
  delivered_at: string | null;
  is_locked: boolean;
  lock_reason: string;
  is_holiday: boolean;
}

export interface HistoryEntry {
  id: number;
  meal_date: string;
  meal_type: MealType;
  status: MealStatus;
  responded_at: string | null;
  delivered_at: string | null;
  marked_by_provider: boolean;
}

export interface PaymentEntry {
  amount: number;
  diets_added: number;
  plan_type: PlanType;
  paid_at: string;
  notes: string;
}

export interface Holiday {
  id?: number;
  holiday_date: string;
  meal_scope: HolidayScope;
  reason: string;
}

export interface CustomerSummary {
  today: string;
  current_time: string;
  customer: CustomerIdentity & { push_enabled: boolean };
  plan: CustomerPlan | null;
  menus: Menus;
  cutoffs: Cutoffs;
  today_meals: Partial<Record<MealType, TodayMeal>>;
  history: HistoryEntry[];
  payments: PaymentEntry[];
  upcoming_holidays: Holiday[];
  popup_broadcast: string;
}

/** Login result. `token` goes in the Authorization header of every later request. */
export interface AuthTokens {
  token: string;
  expires_at: string;
}

/** Only populated when the server runs with DEMO_MODE=1. */
export interface DemoInfo {
  enabled: boolean;
  customers?: (Pick<CustomerIdentity, "id" | "name" | "phone" | "route_area"> & {
    plan_type: PlanType | null;
    pin: string;
  })[];
  provider_pin?: string | null;
  provider_qr_code?: string;
}

export type DemoCustomer = NonNullable<DemoInfo["customers"]>[number];

export interface DashboardCustomer extends CustomerIdentity {
  subscription_id: number | null;
  plan_type: PlanType | null;
  total_diets: number | null;
  diets_consumed: number | null;
  diets_remaining: number | null;
  amount_paid: number | null;
  payment_date: string | null;
  start_date: string | null;
  estimated_end_date: string | null;
}

export interface QueueItem {
  customer_id: number;
  subscription_id: number;
  name: string;
  phone: string;
  address: string;
  route_area: string;
  boxes_with_customer: number;
  plan_type: PlanType;
  diets_remaining: number;
  estimated_end_date: string;
  status: MealStatus;
  delivered_at: string | null;
  responded_at: string | null;
}

export interface QueueRoute {
  route_area: string;
  left_to_deliver: number;
  total: number;
  items: QueueItem[];
}

export interface DeliveryQueue {
  date: string;
  meal_type: MealType;
  is_holiday: boolean;
  holiday_reason: string;
  is_locked: boolean;
  lock_reason: string;
  counts: {
    total_eligible: number;
    confirmed: number;
    pending: number;
    cancelled: number;
    paused: number;
    delivered: number;
    left_to_deliver: number;
  };
  items: QueueItem[];
  routes: QueueRoute[];
}

export interface Dashboard {
  today: string;
  current_time: string;
  cutoffs: Cutoffs;
  menus: Menus;
  provider_qr_code: string;
  popup_broadcast: string;
  total_boxes_out: number;
  customers: DashboardCustomer[];
  holidays: (Holiday & { id: number })[];
  lunch_queue: DeliveryQueue;
  dinner_queue: DeliveryQueue;
  expiring_soon: DashboardCustomer[];
}

export interface ScanResult {
  status: "delivered";
  delivered_at: string;
  diets_consumed: number;
  diets_remaining: number;
  boxes_with_customer: number;
  estimated_end_date: string;
}

export interface MealPromptResult {
  meal_type: MealType;
  meal_date: string;
  recipients: number;
  sent: number;
  failed: number;
  broadcast: string;
  invalid_tokens: string[];
}
