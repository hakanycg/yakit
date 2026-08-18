export type RoleName = "super_admin" | "admin" | "operator" | "viewer";

export interface StationRow {
  id: number;
  slug: string;
  name: string;
  address: string;
  latitude: number | null;
  longitude: number | null;
  active: 0 | 1;
  created_at: string;
}

export interface UserRow {
  id: number;
  username: string;
  display_name: string;
  password_hash: string;
  password_salt: string;
  password_iterations: number;
  role_id: number;
  station_id: number | null; // NULL = super_admin
  active: 0 | 1;
  must_change_password: 0 | 1;
  failed_login_attempts: number;
  locked_until: string | null;
  email: string | null;
  phone: string | null;
  notify_email: 0 | 1;
  notify_sms: 0 | 1;
  created_at: string;
  updated_at: string;
  last_login_at: string | null;
}

export interface RoleRow {
  id: number;
  name: RoleName;
  description: string;
}

export interface SessionRow {
  id: string;
  user_id: number;
  csrf_token: string;
  ip_address: string | null;
  user_agent: string | null;
  created_at: string;
  expires_at: string;
  last_seen_at: string;
}

export type PumpStatus = "idle" | "reserved" | "dispensing" | "fault" | "offline";
export type FuelType = "benzin" | "motorin" | "lpg";

export interface PumpRow {
  id: number;
  station_id: number;
  number: number;
  label: string;
  status: PumpStatus;
  fuel_types: string; // JSON
  pos_x: number;
  pos_y: number;
  fault_code: string | null;
  fault_message: string | null;
  current_transaction_id: number | null;
  updated_at: string;
}

export type TransactionStatus =
  | "created"
  | "paid"
  | "authorized"
  | "dispensing"
  | "completed"
  | "cancelled"
  | "failed";

export type PaymentStatus = "pending" | "authorized" | "captured" | "failed" | "refunded";

export interface TransactionRow {
  id: number;
  station_id: number;
  pump_id: number;
  plate: string;
  plate_source: "manual" | "lpr";
  fuel_type: FuelType;
  amount_mode: "amount" | "liters" | "full_tank";
  requested_amount: number | null;
  requested_liters: number | null;
  price_per_liter: number;
  dispensed_liters: number;
  total_amount: number;
  payment_method: string;
  payment_status: PaymentStatus;
  payment_reference: string | null;
  status: TransactionStatus;
  kiosk_access_token: string;
  operator_user_id: number | null;
  started_at: string | null;
  completed_at: string | null;
  cancelled_reason: string | null;
  receipt_email: string | null;
  receipt_phone: string | null;
  receipt_sent_at: string | null;
  created_at: string;
  updated_at: string;
}

export type AlarmSeverity = "info" | "warning" | "critical";
export type AlarmStatus = "active" | "acknowledged" | "resolved";

export interface AlarmRow {
  id: number;
  station_id: number;
  pump_id: number | null;
  type: string;
  severity: AlarmSeverity;
  message: string;
  status: AlarmStatus;
  acknowledged_by: number | null;
  acknowledged_at: string | null;
  resolved_by: number | null;
  resolved_at: string | null;
  created_at: string;
}

export interface AuditLogRow {
  id: number;
  station_id: number | null;
  user_id: number | null;
  username: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  details: string | null;
  ip_address: string | null;
  created_at: string;
}

export interface FuelPriceRow {
  station_id: number;
  fuel_type: FuelType;
  label: string;
  price_per_liter: number;
  updated_at: string;
}

export interface ShiftRow {
  id: number;
  station_id: number;
  user_id: number;
  started_at: string;
  ended_at: string | null;
  opening_note: string | null;
  closing_note: string | null;
  created_at: string;
}

export interface SettingRow {
  station_id: number;
  key: string;
  value: string;
  updated_at: string;
  updated_by: number | null;
}
