export type RoleName = "super_admin" | "tenant_admin" | "admin" | "operator" | "viewer";

export interface TenantRow {
  id: number;
  name: string;
  slug: string;
  active: 0 | 1;
  created_at: string;
}

export interface StationRow {
  id: number;
  slug: string;
  tenant_id: number | null;
  code: string | null;
  require_kiosk_token: 0 | 1;
  name: string;
  address: string;
  /** Isletme telefonu; kiosk yardim ekraninda musteriye gosterilen numara. */
  contact_phone: string | null;
  latitude: number | null;
  longitude: number | null;
  active: 0 | 1;
  sync_token: string | null;
  created_at: string;
}

export interface StationKioskRow {
  id: number;
  station_id: number;
  label: string;
  anydesk_id: string | null;
  device_token: string | null;
  /** Bu fiziksel kiosk hangi pompanin basinda duruyor; NULL = musteri kendisi secer. */
  pump_id: number | null;
  last_seen_at: string | null;
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
  station_id: number | null; // NULL = super_admin veya tenant_admin
  tenant_id: number | null;  // tenant_admin icin zorunlu, digerlerinde NULL
  active: 0 | 1;
  must_change_password: 0 | 1;
  failed_login_attempts: number;
  locked_until: string | null;
  email: string | null;
  phone: string | null;
  notify_email: 0 | 1;
  notify_sms: 0 | 1;
  reset_token_hash: string | null;
  reset_token_expires_at: string | null;
  totp_secret: string | null;
  totp_enabled: 0 | 1;
  totp_pending_secret: string | null;
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
  protocol_type: string | null;
  protocol_connection_config: string | null;
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

/**
 * Odemenin durumu.
 *
 * "processing" ve "voided" kod tarafindan yaziliyordu ama bu birlesime hic eklenmemisti
 * (touch() gevsek bir Partial aldigi icin TypeScript yakalamamisti) - yani tip, gercekte
 * veritabaninda duran degerleri anlatmiyordu.
 *
 * pending    : odeme hic baslamadi
 * processing : iyzico formu acildi, sonuc henuz bilinmiyor
 * authorized : on-provizyon alindi (full_tank), tahsilat henuz yapilmadi
 * captured   : tahsil edildi
 * voided     : alinan on-provizyon serbest birakildi
 * failed     : tahsilat denendi ve basarisiz oldu
 * refunded   : tahsil edilen tutarin tamami iade edildi
 * cancelled  : odeme hic sonuclanmadan islem iptal edildi - ortada para YOK
 */
export type PaymentStatus =
  | "pending"
  | "processing"
  | "authorized"
  | "captured"
  | "voided"
  | "failed"
  | "refunded"
  | "cancelled";

export interface TransactionRow {
  id: number;
  station_id: number;
  pump_id: number;
  plate: string;
  plate_source: "manual" | "lpr";
  /** Aracin km sayaci; yalnizca filo odemesinde ve opsiyonel olarak toplanir. */
  odometer_km: number | null;
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
  discount_code: string | null;
  discount_amount: number;
  loyalty_points_redeemed: number;
  loyalty_points_earned: number;
  created_at: string;
  updated_at: string;
}

export interface LoyaltyAccountRow {
  station_id: number;
  plate: string;
  points: number;
  updated_at: string;
}

export interface LoyaltyMovementRow {
  id: number;
  station_id: number;
  plate: string;
  type: "earn" | "redeem" | "refund" | "adjustment";
  points: number;
  balance_after: number;
  transaction_id: number | null;
  note: string | null;
  user_id: number | null;
  created_at: string;
}

export interface DiscountCodeRow {
  id: number;
  station_id: number;
  code: string;
  type: "percent" | "fixed";
  value: number;
  fuel_type: FuelType | null;
  max_uses: number | null;
  used_count: number;
  starts_at: string | null;
  expires_at: string | null;
  active: number;
  created_at: string;
  created_by: number | null;
}

export interface SystemErrorRow {
  id: number;
  kind: "request" | "uncaught_exception" | "unhandled_rejection";
  path: string | null;
  message: string;
  created_at: string;
}

export interface FuelSupplierRow {
  id: number;
  station_id: number;
  name: string;
  email: string | null;
  phone: string | null;
  active: number;
  created_at: string;
  created_by: number | null;
}

export interface FuelOrderRow {
  id: number;
  station_id: number;
  fuel_type: string;
  supplier_id: number | null;
  supplier_name: string;
  ordered_liters: number;
  unit_cost: number | null;
  expected_at: string | null;
  status: "draft" | "sent" | "delivering" | "received" | "cancelled";
  note: string | null;
  delivery_movement_id: number | null;
  received_liters: number | null;
  sent_at: string | null;
  // Tanker istasyona gelip personel "Teslimat Basladi" dediginde damgalanir (bkz.
  // fuelOrderService.startDelivery / tankGaugeService.hasActiveDelivery).
  delivery_started_at: string | null;
  received_at: string | null;
  cancelled_at: string | null;
  // Tanker canli konum takibi (bkz. routes/tankerTracking.ts). Sofor telefonu
  // girilmisse siparis gonderilirken bir takip linki SMS'lenir; token kiosk_access_token
  // ile ayni desen (girissiz ama tahmin edilemez, tek siparise ozel, suresi dolar).
  driver_phone: string | null;
  tanker_plate: string | null;
  tracking_token: string | null;
  tracking_token_expires_at: string | null;
  last_lat: number | null;
  last_lng: number | null;
  last_location_at: string | null;
  created_by: number | null;
  created_at: string;
}

export interface ExpenseRow {
  id: number;
  station_id: number;
  category: string;
  description: string | null;
  amount: number;
  expense_date: string;
  created_by: number | null;
  created_at: string;
}

export interface SupplierPaymentRow {
  id: number;
  station_id: number;
  supplier_id: number;
  amount: number;
  payment_date: string;
  note: string | null;
  created_by: number | null;
  created_at: string;
}

export interface CashAccountRow {
  id: number;
  station_id: number;
  name: string;
  kind: "bank" | "cash";
  active: number;
  created_at: string;
  created_by: number | null;
}

export interface CashAccountMovementRow {
  id: number;
  station_id: number;
  account_id: number;
  direction: "in" | "out";
  amount: number;
  movement_date: string;
  description: string | null;
  created_by: number | null;
  created_at: string;
}

export interface StaffAdvanceRow {
  id: number;
  station_id: number;
  user_id: number;
  kind: "avans" | "masraf";
  amount: number;
  description: string | null;
  entry_date: string;
  settled: number;
  settled_at: string | null;
  created_by: number | null;
  created_at: string;
}

export interface FleetAccountRow {
  id: number;
  station_id: number;
  company_name: string;
  vkn: string | null;
  billing_type: "prepaid" | "postpaid";
  balance: number;
  credit_limit: number | null;
  active: number;
  contact_email: string | null;
  contact_phone: string | null;
  low_balance_threshold: number | null;
  /** postpaid: fatura tarihinden itibaren vade (gun). NULL = alacak takibi kapali. */
  payment_term_days: number | null;
  /** Vadesi bu kadar gun gecmis faturasi olan hesapta yakit alimi reddedilir. NULL = kapali. */
  overdue_block_days: number | null;
  created_at: string;
  created_by: number | null;
}

export interface FleetPlateRow {
  id: number;
  fleet_account_id: number;
  plate: string;
  expected_fuel_type: FuelType | null;
  created_at: string;
}

export interface FleetMovementRow {
  id: number;
  fleet_account_id: number;
  type: "topup" | "charge" | "refund" | "adjustment";
  amount: number;
  balance_after: number;
  transaction_id: number | null;
  note: string | null;
  user_id: number | null;
  /** Bu hareketi kapsayan donem faturasi. null: henuz faturalanmadi. */
  fleet_invoice_id: number | null;
  created_at: string;
}

export interface FleetInvoiceRow {
  id: number;
  station_id: number;
  fleet_account_id: number;
  status: "pending" | "sent" | "failed";
  provider: string;
  provider_invoice_id: string | null;
  error_message: string | null;
  period_start: string;
  period_end: string;
  total_liters: number;
  tax_exclusive_amount: number;
  tax_amount: number;
  payable_amount: number;
  lines_json: string;
  /** Fatura kesildigi anda dondurulan vade tarihi. NULL = hesapta vade tanimli degildi. */
  due_date: string | null;
  created_by: number | null;
  created_at: string;
}

export interface FleetTopupRequestRow {
  id: number;
  station_id: number;
  fleet_account_id: number;
  portal_user_id: number;
  requested_amount: number;
  note: string | null;
  status: "pending" | "approved" | "rejected";
  /** Personelin FIILEN tahsil ettigi tutar; talep edilenle ayni olmak zorunda degil. */
  approved_amount: number | null;
  handled_by: number | null;
  handled_at: string | null;
  handled_note: string | null;
  created_at: string;
}

export interface FleetPortalUserRow {
  id: number;
  email: string;
  display_name: string | null;
  password_hash: string;
  password_salt: string;
  password_iterations: number;
  must_change_password: number;
  active: number;
  failed_login_attempts: number;
  locked_until: string | null;
  last_login_at: string | null;
  created_at: string;
  created_by: number | null;
}

export interface FleetPortalSessionRow {
  id: string;
  portal_user_id: number;
  csrf_token: string;
  ip_address: string | null;
  user_agent: string | null;
  created_at: string;
  expires_at: string;
  last_seen_at: string;
}

export interface FuelPriceHistoryRow {
  id: number;
  station_id: number;
  fuel_type: FuelType;
  price_per_liter: number;
  changed_by: number | null;
  created_at: string;
}

export interface InvoiceRow {
  id: number;
  station_id: number;
  transaction_id: number;
  status: "pending" | "sent" | "failed";
  provider: string;
  provider_invoice_id: string | null;
  error_message: string | null;
  created_by: number | null;
  created_at: string;
}

export interface WaybillRow {
  id: number;
  station_id: number;
  movement_id: number;
  status: "pending" | "sent" | "failed";
  provider: string;
  provider_waybill_id: string | null;
  error_message: string | null;
  created_by: number | null;
  created_at: string;
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
  /** 0 = yalnizca ilk bildirim, 1 = hatirlatma, 2 = ust kademeye yukseltildi. */
  escalation_level: number;
  last_notified_at: string | null;
  created_at: string;
}

export interface AuditLogRow {
  id: number;
  station_id: number | null;
  user_id: number | null;
  username: string | null;
  actor_type: string | null;
  role: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  details: string | null;
  ip_address: string | null;
  user_agent: string | null;
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

export interface FuelTankRow {
  station_id: number;
  fuel_type: FuelType;
  capacity_liters: number;
  current_liters: number;
  low_stock_threshold_liters: number;
  average_cost_per_liter: number;
  probe_brand: string | null;
  probe_connection_config: string | null;
  updated_at: string;
  updated_by: number | null;
}

export interface FuelTankReadingRow {
  id: number;
  station_id: number;
  fuel_type: FuelType;
  measured_liters: number;
  book_liters: number;
  variance_liters: number;
  throughput_liters: number;
  variance_pct: number;
  previous_reading_id: number | null;
  source: "manual" | "auto";
  temperature_celsius: number | null;
  /** Tank dibindeki su seviyesi (mm). NULL = olculmedi (sifir DEGIL). */
  water_level_mm: number | null;
  /** Sicaklik farkinin acikladigi litre. NULL = duzeltme yapilamadi (sifir cikti DEGIL). */
  temperature_correction_liters: number | null;
  /** Sicaklik ayiklandiktan sonra kalan sapma; alarm karari buna bakar. NULL = duzeltme yok. */
  adjusted_variance_liters: number | null;
  alarm_id: number | null;
  note: string | null;
  measured_at: string;
  user_id: number | null;
  created_at: string;
}

export interface PumpTotalizerReadingRow {
  id: number;
  station_id: number;
  pump_id: number;
  fuel_type: FuelType;
  totalizer_liters: number;
  previous_reading_id: number | null;
  previous_totalizer_liters: number | null;
  dispensed_liters: number;
  recorded_liters: number;
  variance_liters: number;
  variance_pct: number;
  is_meter_reset: 0 | 1;
  alarm_id: number | null;
  note: string | null;
  measured_at: string;
  user_id: number | null;
  created_at: string;
}

export type FuelStockMovementType = "delivery" | "sale" | "adjustment";

export interface FuelStockMovementRow {
  id: number;
  station_id: number;
  fuel_type: FuelType;
  type: FuelStockMovementType;
  liters: number;
  balance_after: number;
  supplier: string | null;
  delivery_ref: string | null;
  note: string | null;
  unit_cost: number | null;
  /** Yalnizca delivery: irsaliyede yazan miktar. liters ise tanka FIILEN giren miktardir. */
  declared_liters: number | null;
  measured_before_liters: number | null;
  measured_after_liters: number | null;
  /** Fiilen giren - irsaliye. Eksi: teslimat eksik geldi. Olcum yoksa null. */
  delivery_variance_liters: number | null;
  delivery_variance_pct: number | null;
  transaction_id: number | null;
  user_id: number | null;
  created_at: string;
}

export type PumpMaintenanceLogType = "maintenance" | "note";

export interface PumpMaintenanceLogRow {
  id: number;
  station_id: number;
  pump_id: number;
  type: PumpMaintenanceLogType;
  description: string;
  user_id: number | null;
  created_at: string;
}

export interface PumpCalibrationRow {
  id: number;
  station_id: number;
  pump_id: number;
  fuel_type: FuelType;
  reference_liters: number;
  metered_liters: number;
  /** metered - reference. Arti: pompa oldugundan FAZLA gosteriyor (musteri aleyhine). */
  error_liters: number;
  error_pct: number;
  within_tolerance: number;
  seal_valid_until: string | null;
  seal_reference: string | null;
  note: string | null;
  tested_at: string;
  user_id: number | null;
}

export interface RefundRow {
  id: number;
  station_id: number;
  transaction_id: number;
  amount: number;
  reason: string;
  payment_method: string;
  provider_refund_id: string | null;
  status: "completed" | "failed";
  error_message: string | null;
  user_id: number | null;
  created_at: string;
}

export type ScheduledPriceChangeStatus = "pending" | "applied" | "cancelled";

export interface ScheduledPriceChangeRow {
  id: number;
  station_id: number;
  fuel_type: FuelType;
  price_per_liter: number;
  scheduled_for: string;
  status: ScheduledPriceChangeStatus;
  created_at: string;
  created_by: number | null;
  applied_at: string | null;
}

export interface WriteQueueRow {
  id: number;
  kind: string;
  payload: string;
  attempts: number;
  last_error: string | null;
  created_at: string;
  processed_at: string | null;
}

export interface StationSyncStateRow {
  station_id: number;
  last_heartbeat_at: string | null;
  last_synced_at: string | null;
  updated_at: string;
}

export type StationSyncEventStatus = "received" | "applied" | "failed";

export interface StationSyncEventRow {
  id: number;
  station_id: number;
  client_event_id: string;
  event_type: string;
  payload: string;
  status: StationSyncEventStatus;
  error_message: string | null;
  received_at: string;
}
